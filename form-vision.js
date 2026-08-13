/* =========================================================================
 * form-vision.js  —  深掘り層（キーフレーム / 動画クリップ + AI講評）
 * -------------------------------------------------------------------------
 *  Phase 3 + Gemini対応。プロバイダを切り替えて使う。
 *
 *      const stills = new KeyframeRecorder({ video: videoEl });
 *      const clips  = new ClipRecorder({ stream });          // Gemini用（任意）
 *      const vision = new VisionCoach({ provider:'gemini', apiKey: key });
 *      attachVision(coach, { stills, clips }, vision);
 *
 *  - anthropic … 静止画のみ。1レップを 開始/中間/最下点 の3枚に圧縮して送る。
 *  - gemini    … 動画クリップを送れる。潰れる瞬間・バーの軌跡・切り返しの速さは
 *                静止画では原理的に落ちるので、動作解析では動画のほうが強い。
 *                クリップが取れない環境では自動的に静止画へ退避する。
 *
 *  【セキュリティ】APIキーは直書きせずBYOK（利用者入力→localStorage）。
 *   Anthropic のブラウザ直叩きには anthropic-dangerous-direct-browser-access が要る。
 *   Gemini のブラウザ直叩き可否は probe() で事前確認できる。
 *  【プライバシー】Gemini の無料枠は入力がモデル改善に使われうる。
 *   自分の身体の映像を送る点に注意。課金を有効にすれば回避できる。
 * ========================================================================= */

(function (global) {
  'use strict';

  /* =======================================================================
   * KeyframeRecorder — 判定に効く瞬間だけをJPEGで残す
   * ===================================================================== */
  class KeyframeRecorder {
    constructor(opts) {
      opts = opts || {};
      this.video = opts.video || null;
      this.maxWidth = opts.maxWidth || 448;
      this.quality = opts.quality != null ? opts.quality : 0.6;
      this.maxReps = opts.maxReps != null ? opts.maxReps : 10;
      this.minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : 90;
      this.captureFn = opts.capture || null;      // テスト時に差し替え可能
      this.mirrored = !!opts.mirrored;            // インカメラの左右反転
      this.now = opts.now || (() => (global.performance ? performance.now() : Date.now()));

      this._canvas = null;
      this.reps = [];        // 完了したrepのフレーム
      this._cur = null;
      this._lastCapAt = -1e9;
      this._prevPhase = null;
    }

    _blank() { return { top: null, mid: null, bottom: null, bottomProgress: -1, midDone: false }; }

    /** video要素から1枚取り出してdataURLにする */
    _grab() {
      if (this.captureFn) return this.captureFn();
      const v = this.video;
      if (!v || !v.videoWidth) return null;
      if (!this._canvas) this._canvas = global.document.createElement('canvas');
      const scale = Math.min(1, this.maxWidth / v.videoWidth);
      const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
      const c = this._canvas;
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      const ctx = c.getContext('2d');
      ctx.save();
      if (this.mirrored) { ctx.translate(w, 0); ctx.scale(-1, 1); }
      ctx.drawImage(v, 0, 0, w, h);
      ctx.restore();
      try { return c.toDataURL('image/jpeg', this.quality); } catch (e) { return null; }
    }

    /** エンジン出力を毎フレーム渡す */
    onFrame(out) {
      if (!out || !out.ok || out.calibrating) return;
      const now = this.now();
      if (!this._cur) this._cur = this._blank();
      const p = out.progress || 0;

      // 開始姿勢は立位のうちに押さえる（下降開始を待つと既に動き出している）
      if (out.phase === 'top' && !this._cur.top && now - this._lastCapAt >= this.minIntervalMs) {
        this._cur.top = this._grab();
        this._lastCapAt = now;
      }
      // 下降中の中間点（膝の軌跡が最も読める位置）
      if (!this._cur.midDone && out.phase === 'descending' && p >= 0.45) {
        if (now - this._lastCapAt >= this.minIntervalMs) {
          this._cur.mid = this._grab(); this._cur.midDone = true; this._lastCapAt = now;
        }
      }
      // 折り返しは事後にしか分からない。より深い値が来るたびに置き換えて収束させる
      if (p > this._cur.bottomProgress + 0.03 && p >= 0.5) {
        if (now - this._lastCapAt >= this.minIntervalMs) {
          const img = this._grab();
          if (img) { this._cur.bottom = img; this._cur.bottomProgress = p; this._lastCapAt = now; }
        }
      }
      this._prevPhase = out.phase;

      if (out.repCompleted) {
        this.reps.push({
          index: out.repCompleted.index,
          top: this._cur.top, mid: this._cur.mid, bottom: this._cur.bottom,
        });
        while (this.reps.length > this.maxReps) this.reps.shift();
        this._cur = this._blank();
      }
    }

    framesFor(index) { return this.reps.find(r => r.index === index) || null; }
    clear() { this.reps = []; this._cur = null; this._prevPhase = null; }
    get sizeEstimateKB() {
      let n = 0;
      for (const r of this.reps) for (const k of ['top', 'mid', 'bottom']) if (r[k]) n += r[k].length;
      return Math.round(n * 0.75 / 1024);
    }
  }


  /* =======================================================================
   * ClipRecorder — レップ単位で動画クリップを切り出す
   *
   *  MediaRecorder のチャンクは単体では再生できない（先頭にしかヘッダが無い）。
   *  連続録画を後から切るのではなく、レップごとに start/stop して完結した
   *  ファイルを作る。予測可能性を優先した設計。
   *
   *  1本 = 立位 → 下降 → 最下点 → 挙上 → 立位（rep成立で確定）
   *  レップが成立しないまま長引いた区間は捨てて録り直す。
   * ===================================================================== */
  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1',      // Safari
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];

  class ClipRecorder {
    constructor(opts) {
      opts = opts || {};
      this.stream = opts.stream || null;
      this.bitrate = opts.bitrate != null ? opts.bitrate : 900000;
      this.maxReps = opts.maxReps != null ? opts.maxReps : 6;
      this.maxClipMs = opts.maxClipMs != null ? opts.maxClipMs : 15000;
      this.maxBytes = opts.maxBytes != null ? opts.maxBytes : 4 * 1024 * 1024;
      this.RecorderClass = opts.RecorderClass ||
        (typeof global.MediaRecorder !== 'undefined' ? global.MediaRecorder : null);
      this.BlobClass = opts.BlobClass || global.Blob;
      this.now = opts.now || (() => (global.performance ? performance.now() : Date.now()));
      this.mime = this._pickMime();
      this.clips = [];
      this._mr = null; this._chunks = []; this._startedAt = 0; this._stopping = false;
      this.available = !!(this.RecorderClass && this.stream && this.mime);
      this.lastError = this.available ? null
        : (!this.RecorderClass ? 'MediaRecorder非対応'
          : (!this.stream ? 'ストリームなし' : '対応する動画形式なし'));
    }

    _pickMime() {
      const R = this.RecorderClass;
      if (!R) return null;
      if (!R.isTypeSupported) return 'video/webm';
      for (const m of MIME_CANDIDATES) { try { if (R.isTypeSupported(m)) return m; } catch (e) {} }
      return null;
    }

    _begin() {
      if (!this.available || this._mr || this._stopping) return;
      try {
        this._chunks = [];
        const mr = new this.RecorderClass(this.stream,
          { mimeType: this.mime, videoBitsPerSecond: this.bitrate });
        mr.ondataavailable = e => { if (e && e.data && e.data.size) this._chunks.push(e.data); };
        mr.start(1000);   // 定期的にチャンクを出させる（停止時の1発頼みにしない）
        this._mr = mr; this._startedAt = this.now();
      } catch (e) { this.available = false; this.lastError = e && e.message; }
    }

    _end(index) {
      const mr = this._mr;
      if (!mr) return;
      this._mr = null; this._stopping = true;
      const finish = () => {
        this._stopping = false;
        // stop() は dataavailable を発火してから onstop を呼ぶ。
        // 最後のチャンクはここで初めて揃うので、回収はこの時点で行う。
        const chunks = this._chunks; this._chunks = [];
        if (index != null && chunks.length) {
          try {
            const blob = new this.BlobClass(chunks, { type: this.mime });
            if (blob.size <= this.maxBytes) {
              this.clips.push({ index, blob, mime: this.mime, bytes: blob.size });
              while (this.clips.length > this.maxReps) this.clips.shift();
            }
          } catch (e) {}
        }
        this._begin();
      };
      mr.onstop = finish;
      try { mr.stop(); } catch (e) { finish(); }
    }

    start() { this._begin(); }
    stop() { this._end(null); }

    /** エンジン出力を毎フレーム渡す */
    onFrame(out) {
      if (!this.available || !out) return;
      if (!this._mr && !this._stopping) { this._begin(); return; }
      if (out.repCompleted) { this._end(out.repCompleted.index); return; }
      // レップが成立しないまま長引いた区間は捨てる（メモリと無駄送信の抑制）
      if (this._mr && this.now() - this._startedAt > this.maxClipMs) this._end(null);
    }

    clipFor(i) { return this.clips.find(c => c.index === i) || null; }
    clear() { this.clips = []; }
    get sizeKB() { return Math.round(this.clips.reduce((s, c) => s + c.bytes, 0) / 1024); }
  }

  function scoreRep(rep) {
    let s = 0;
    for (const v of (rep.violations || [])) s += (v.level === 'danger' ? 3 : 1) * Math.min(v.count, 20) / 5;
    if (rep.romPercent != null) s += Math.max(0, 85 - rep.romPercent) / 8;
    return s;
  }

  function selectReps(summary) {
    const reps = summary.reps || [];
    if (!reps.length) return [];
    const worst = reps.slice().sort((a, b) => scoreRep(b) - scoreRep(a))[0];
    const last = reps[reps.length - 1];
    const out = [{ rep: worst, role: '最も崩れたレップ' }];
    if (last.index !== worst.index) out.push({ rep: last, role: '最終レップ（疲労の確認用）' });
    return out;
  }


  /* =======================================================================
   * プロンプト
   * ===================================================================== */
  function systemPrompt(hasVideo) {
    return [
      'あなたは経験豊富なストレングスコーチだ。' + (hasVideo ? '動画' : '静止画')
        + 'とルールベース解析の数値から、フォームの問題を指摘する。',
      '',
      '厳守する制約:',
      '- 映像は単眼2Dである。奥行き方向の動き（前後の重心移動、骨盤の回旋、脊柱の細かな屈曲）は正確には見えない。見えないものを断定するな。判断材料が不足する場合は visibleFromCamera を false にし、confidence を下げよ。',
      '- 医学的な診断をするな。痛みや傷害に言及する必要がある場合は、医療者への相談を促すにとどめよ。',
      '- 与えられる数値はルールベース層の出力であり、誤検知しうる。映像と矛盾する場合は指摘に従わず、disagreeWithRules に理由とともに記せ。',
      '- 推測で細部を埋めるな。映像から読み取れた事実と、数値から言えることを区別せよ。',
      hasVideo
        ? '- 動画では、静止画では分からないものを優先して見よ。切り返しの速さ、バーの軌跡、崩れが始まる瞬間、左右差が出るタイミング。'
        : '- 静止画では動きの速さや軌跡は分からない。テンポに関する指摘は数値のみを根拠とせよ。',
      '- トーンはストイックかつ簡潔。命令形を使う。称賛は事実の記述にとどめ、励ましの言葉を足すな。',
      '- 高重量種目で危険な兆候があれば、重量を下げるか中止するよう明確に述べよ。',
      '',
      '出力はJSONオブジェクトのみ。コードフェンスも前置きも付けるな。スキーマ:',
      '{',
      '  "overall": "全体講評。2文以内。",',
      '  "priorityFix": { "title": "最優先の修正点", "why": "根拠。映像と数値のどちらに基づくか明示する", "cue": "次のセット中に意識させる短い指示" },',
      '  "secondary": ["副次的な指摘（最大2件）"],',
      '  "spoken": "音声で読み上げる1文。30字以内。命令形。",',
      '  "visibleFromCamera": true,',
      '  "disagreeWithRules": [{ "ruleId": "ルールID", "reason": "映像上そうは見えない理由" }],',
      '  "confidence": 0.0',
      '}',
    ].join('\n');
  }

  function buildDataText(summary, picks, mode) {
    const L = [];
    L.push('種目: ' + (summary.exerciseLabel || summary.exercise));
    L.push('カメラアングル: ' + (summary.view === 'front' ? '正面' : '側面'));
    L.push('レップ数: ' + summary.repCount
      + (summary.durationMs ? ' / 所要 ' + Math.round(summary.durationMs / 1000) + '秒' : ''));
    if (summary.romTrend && summary.romTrend.length) L.push('可動域の推移(%): ' + summary.romTrend.join(', '));
    if (summary.avgEccentricMs != null)
      L.push('平均テンポ: 下ろし ' + summary.avgEccentricMs + 'ms / 挙上 ' + summary.avgConcentricMs + 'ms');
    if (summary.faultTotals && summary.faultTotals.length) {
      L.push('ルールベース層の検出:');
      for (const f of summary.faultTotals) L.push('  - ' + f.id + ': ' + f.reps + 'レップで検出');
    } else L.push('ルールベース層の検出: なし');
    L.push('');
    L.push(mode === 'video' ? '添付動画:' : '添付画像:');
    for (const p of picks) {
      const v = (p.rep.violations || []).map(x => x.id + '(' + x.level + ')').join(', ') || 'なし';
      L.push('  レップ' + p.rep.index + '【' + p.role + '】ROM=' + p.rep.romPercent + '% 逸脱=' + v);
    }
    L.push('');
    L.push(mode === 'video'
      ? '各動画は1レップ分（立位から立位まで）。上の一覧と順に対応する。'
      : '画像は各レップについて 開始 / 下降中間 / 最下点 の順で並ぶ（欠落する場合がある）。');
    L.push('数値で既に分かっていることの繰り返しではなく、数値には現れない崩れを指摘せよ。');
    return L.join('\n');
  }

  /* Gemini の構造化出力スキーマ。プロンプト頼みよりJSON崩れが起きにくい */
  const RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      overall: { type: 'STRING' },
      priorityFix: { type: 'OBJECT',
        properties: { title: { type: 'STRING' }, why: { type: 'STRING' }, cue: { type: 'STRING' } },
        required: ['title', 'why', 'cue'] },
      secondary: { type: 'ARRAY', items: { type: 'STRING' } },
      spoken: { type: 'STRING' },
      visibleFromCamera: { type: 'BOOLEAN' },
      disagreeWithRules: { type: 'ARRAY', items: { type: 'OBJECT',
        properties: { ruleId: { type: 'STRING' }, reason: { type: 'STRING' } },
        required: ['ruleId', 'reason'] } },
      confidence: { type: 'NUMBER' },
    },
    required: ['overall', 'priorityFix', 'spoken', 'visibleFromCamera', 'confidence'],
  };

  /* =======================================================================
   * 添付データの組み立て
   * ===================================================================== */
  function splitDataUrl(u) {
    if (!u || u.indexOf('base64,') < 0) return null;
    const c = u.indexOf('base64,');
    return { mime: u.slice(5, u.indexOf(';')) || 'image/jpeg', data: u.slice(c + 7) };
  }
  function blobToBase64(blob) {
    return new Promise((res, rej) => {
      const R = global.FileReader;
      if (!R) return rej(new Error('no FileReader'));
      const r = new R();
      r.onload = () => { const s = String(r.result); const c = s.indexOf('base64,');
        c < 0 ? rej(new Error('encode failed')) : res(s.slice(c + 7)); };
      r.onerror = () => rej(new Error('read failed'));
      r.readAsDataURL(blob);
    });
  }
  function normalizeSource(src) {
    if (!src) return { stills: null, clips: null };
    if (src.stills || src.clips) return { stills: src.stills || null, clips: src.clips || null };
    if (typeof src.clipFor === 'function') return { stills: null, clips: src };
    return { stills: src, clips: null };
  }

  /* 動画が1本でも取れれば動画モード。取れなければ静止画へ退避する */
  async function collectAttachments(picks, source, provider, maxImages) {
    const { stills, clips } = normalizeSource(source);
    if (provider === 'gemini' && clips && clips.available !== false) {
      const vids = [];
      for (const p of picks) {
        const c = clips.clipFor(p.rep.index);
        if (!c) continue;
        try {
          vids.push({ kind: 'video', mime: c.mime, data: await blobToBase64(c.blob),
                      label: 'レップ' + p.rep.index });
        } catch (e) {}
      }
      if (vids.length) return { mode: 'video', items: vids };
    }
    const imgs = [];
    if (stills) {
      for (let i = 0; i < picks.length; i++) {
        const fr = stills.framesFor(picks[i].rep.index);
        if (!fr) continue;
        // 主対象は3枚。2件目以降は単独で最も情報量の多い最下点のみ
        for (const k of (i === 0 ? ['top', 'mid', 'bottom'] : ['bottom'])) {
          if (imgs.length >= maxImages) break;
          const s = splitDataUrl(fr[k]);
          if (!s) continue;
          imgs.push({ kind: 'image', mime: s.mime, data: s.data,
            label: 'レップ' + picks[i].rep.index + ' / '
              + (k === 'top' ? '開始' : k === 'mid' ? '下降中間' : '最下点') });
        }
      }
    }
    return { mode: 'image', items: imgs };
  }


  /* =======================================================================
   * VisionCoach
   * ===================================================================== */
  const DEFAULTS = {
    anthropic: { endpoint: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-4-6' },
    gemini:    { endpoint: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-2.5-flash' },
  };

  class VisionCoach {
    constructor(opts) {
      opts = opts || {};
      this.provider = opts.provider || 'anthropic';
      const d = DEFAULTS[this.provider] || DEFAULTS.anthropic;
      this.apiKey = opts.apiKey || null;
      this.endpoint = opts.endpoint || d.endpoint;
      this.model = opts.model || d.model;
      this.maxTokens = opts.maxTokens || 1200;
      this.timeoutMs = opts.timeoutMs || 60000;   // 動画は解析に時間がかかる
      this.maxImages = opts.maxImages != null ? opts.maxImages : 4;
      this.minReps = opts.minReps != null ? opts.minReps : 3;
      this.maxRetries = opts.maxRetries != null ? opts.maxRetries : 2;
      this.fetchImpl = opts.fetch || (global.fetch ? global.fetch.bind(global) : null);
      this.onStatus = opts.onStatus || null;
    }
    setProvider(p, key) {
      this.provider = p;
      const d = DEFAULTS[p] || DEFAULTS.anthropic;
      this.endpoint = d.endpoint; this.model = d.model;
      if (key !== undefined) this.apiKey = key || null;
    }
    _status(s, d) { if (this.onStatus) { try { this.onStatus(s, d); } catch (e) {} } }
    _url() {
      return this.provider === 'gemini'
        ? this.endpoint + '/' + this.model + ':generateContent' : this.endpoint;
    }
    _headers() {
      const h = { 'content-type': 'application/json' };
      if (!this.apiKey) return h;
      if (this.provider === 'gemini') h['x-goog-api-key'] = this.apiKey;
      else {
        h['x-api-key'] = this.apiKey;
        h['anthropic-version'] = '2023-06-01';
        h['anthropic-dangerous-direct-browser-access'] = 'true';  // ブラウザ直叩きに必須
      }
      return h;
    }
    _body(text, att) {
      if (this.provider === 'gemini') {
        const parts = [{ text }];
        for (const it of att.items) {
          parts.push({ text: it.label });
          parts.push({ inlineData: { mimeType: it.mime, data: it.data } });
        }
        return {
          systemInstruction: { parts: [{ text: systemPrompt(att.mode === 'video') }] },
          contents: [{ role: 'user', parts }],
          generationConfig: { maxOutputTokens: this.maxTokens, temperature: 0.4,
            responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
        };
      }
      const content = [{ type: 'text', text }];
      for (const it of att.items) {
        content.push({ type: 'text', text: it.label });
        content.push({ type: 'image', source: { type: 'base64', media_type: it.mime, data: it.data } });
      }
      return { model: this.model, max_tokens: this.maxTokens,
        system: systemPrompt(false), messages: [{ role: 'user', content }] };
    }

    /** ブラウザから直接叩けるか（CORS疎通）を最小コストで確認する */
    async probe() {
      if (!this.fetchImpl) return { ok: false, reason: 'no_fetch' };
      if (!this.apiKey) return { ok: false, reason: 'no_key' };
      const body = this.provider === 'gemini'
        ? { contents: [{ role: 'user', parts: [{ text: 'ping' }] }], generationConfig: { maxOutputTokens: 1 } }
        : { model: this.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
      try {
        const res = await this.fetchImpl(this._url(),
          { method: 'POST', headers: this._headers(), body: JSON.stringify(body) });
        if (res.ok) return { ok: true };
        let d = ''; try { d = (await res.text()).slice(0, 160); } catch (e) {}
        return { ok: false, reason: 'http_' + res.status, detail: d };
      } catch (e) {
        // CORSで弾かれると TypeError: Failed to fetch になり、詳細は取得できない
        return { ok: false, reason: 'cors_or_network', detail: e && e.message };
      }
    }

    async analyzeSet(summary, source) {
      if (!summary || summary.repCount < this.minReps) return { ok: false, reason: 'too_few_reps' };
      if (!this.fetchImpl) return { ok: false, reason: 'no_fetch' };
      if (!this.apiKey) return { ok: false, reason: 'no_key' };
      if (global.navigator && global.navigator.onLine === false) return { ok: false, reason: 'offline' };

      const picks = selectReps(summary);
      const att = await collectAttachments(picks, source, this.provider, this.maxImages);
      if (!att.items.length) return { ok: false, reason: 'no_media' };

      const text = buildDataText(summary, picks, att.mode);
      const body = this._body(text, att);
      const headers = this._headers();
      this._status('start', { mode: att.mode, count: att.items.length });

      let lastErr = null;
      for (let a = 0; a <= this.maxRetries; a++) {
        if (a > 0) {
          const w = 800 * Math.pow(2, a - 1);
          this._status('retry', { attempt: a, wait: w });
          await new Promise(r => setTimeout(r, w));
        }
        const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), this.timeoutMs) : null;
        try {
          const res = await this.fetchImpl(this._url(), { method: 'POST', headers,
            body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
          if (timer) clearTimeout(timer);
          if (!res.ok) {
            let d = ''; try { d = (await res.text()).slice(0, 200); } catch (e) {}
            lastErr = { status: res.status, detail: d };
            if ((res.status === 429 || res.status >= 500) && a < this.maxRetries) continue;
            this._status('error', lastErr);
            return { ok: false, reason: 'http_' + res.status, detail: d };
          }
          const parsed = parseResponse(await res.json(), this.provider);
          if (!parsed) {
            if (a < this.maxRetries) continue;
            this._status('error', { reason: 'unparsable' });
            return { ok: false, reason: 'unparsable' };
          }
          this._status('done', parsed);
          return { ok: true, analysis: parsed, mode: att.mode,
            attachments: att.items.length, repsAnalyzed: picks.map(p => p.rep.index) };
        } catch (e) {
          if (timer) clearTimeout(timer);
          const aborted = e && e.name === 'AbortError';
          lastErr = { reason: aborted ? 'timeout' : 'cors_or_network', message: e && e.message };
          if (a < this.maxRetries) continue;
          this._status('error', lastErr);
          return { ok: false, reason: lastErr.reason, detail: lastErr.message };
        }
      }
      return { ok: false, reason: 'exhausted', detail: lastErr };
    }
  }

  /** APIレスポンス → 正規化。プロバイダ差はここで吸収する */
  function parseResponse(data, provider) {
    if (!data) return null;
    let text = '';
    if (provider === 'gemini') {
      const c = data.candidates && data.candidates[0];
      const parts = c && c.content && c.content.parts;
      if (Array.isArray(parts)) text = parts.map(p => (p && p.text) ? p.text : '').filter(Boolean).join('\n');
    } else if (Array.isArray(data.content)) {
      text = data.content.map(b => (b && b.type === 'text' ? b.text : '')).filter(Boolean).join('\n');
    }
    text = (text || '').trim();
    if (!text) return null;

    let raw = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch (e) {
      const s = raw.indexOf('{'), t = raw.lastIndexOf('}');
      if (s >= 0 && t > s) { try { obj = JSON.parse(raw.slice(s, t + 1)); } catch (e2) {} }
    }
    if (!obj || typeof obj !== 'object') return null;

    const str = (v, m) => (typeof v === 'string' ? v.trim().slice(0, m || 400) : '');
    const pf = obj.priorityFix || {};
    return {
      overall: str(obj.overall, 300),
      priorityFix: { title: str(pf.title, 80), why: str(pf.why, 300), cue: str(pf.cue, 80) },
      secondary: Array.isArray(obj.secondary) ? obj.secondary.map(x => str(x, 160)).filter(Boolean).slice(0, 2) : [],
      spoken: str(obj.spoken, 60),
      visibleFromCamera: obj.visibleFromCamera !== false,
      disagreeWithRules: Array.isArray(obj.disagreeWithRules)
        ? obj.disagreeWithRules.map(d => ({ ruleId: str(d && d.ruleId, 40), reason: str(d && d.reason, 200) }))
            .filter(d => d.ruleId).slice(0, 4) : [],
      confidence: (typeof obj.confidence === 'number' && isFinite(obj.confidence))
        ? Math.max(0, Math.min(1, obj.confidence)) : null,
    };
  }

  /* =======================================================================
   * FormCoach への配線
   * ===================================================================== */
  function attachVision(coach, source, vision, opts) {
    opts = opts || {};
    const prev = coach.onSetComplete;
    const { stills, clips } = normalizeSource(source);
    coach.onSetComplete = async (summary) => {
      if (prev) { try { prev(summary); } catch (e) {} }
      if (opts.onStart) opts.onStart(summary);
      const r = await vision.analyzeSet(summary, source);
      if (r.ok) {
        // 講評は休憩中なので急がない。優先度は低く、TTLは長く。
        if (r.analysis.spoken) coach.voice.say(r.analysis.spoken, { priority: 2, tag: 'vision', ttlMs: 15000 });
        if (opts.onResult) opts.onResult(r.analysis, r);
      } else if (opts.onError) opts.onError(r);
      if (stills) stills.clear();
      if (clips) clips.clear();
      return r;
    };
    return coach;
  }

  const api = { KeyframeRecorder, ClipRecorder, VisionCoach, attachVision,
                selectReps, scoreRep, parseResponse, systemPrompt, buildDataText, DEFAULTS };
  global.KeyframeRecorder = KeyframeRecorder;
  global.ClipRecorder = ClipRecorder;
  global.VisionCoach = VisionCoach;
  global.attachVision = attachVision;
  global.FormVisionKit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
