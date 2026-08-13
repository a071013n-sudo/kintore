/* =========================================================================
 * form-coach.js  —  即時フィードバック層（音声 / 効果音 / 発話調停）
 * -------------------------------------------------------------------------
 *  Phase 2: form-engine.js の出力を「人が聞ける形」に変換する層
 *
 *  依存: form-engine.js（先に読み込むこと）
 *
 *      const engine = new FormEngine('squat', { view: 'front' });
 *      const coach  = new FormCoach(engine);
 *      startBtn.onclick = () => coach.unlock();   // iOS対策: 必ずユーザー操作内で
 *      // onResults 内:
 *      coach.handle(engine.update(results.poseLandmarks, performance.now()));
 *
 *  設計の中心は「何を喋るか」ではなく「何を喋らないか」:
 *   - TTSは発話に200〜400msかかる。危険指摘は先にビープを鳴らして即時性を確保する。
 *   - 動作中に喋り終わらなかった指摘は無効。TTL切れで破棄する（今さら言われても困る）。
 *   - 1repあたりの指摘数に上限を設ける。全部言うと何も伝わらない。
 *   - 同時発火は優先度で1つに潰す。キューは積まない。
 * ========================================================================= */

(function (global) {
  'use strict';

  const PRIORITY = { COUNT: 1, FORM: 2, DANGER: 3 };

  /* =======================================================================
   * 効果音（WebAudio）
   *   TTSより圧倒的に低遅延。「今」を伝えるのは音声ではなく音でやる。
   * ===================================================================== */
  class Beeper {
    constructor(opts) {
      opts = opts || {};
      this.enabled = opts.enabled !== false;
      this.volume = opts.volume != null ? opts.volume : 0.35;
      this.ctx = null;
    }
    unlock() {
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        // iOS: 無音を1つ鳴らしてアンロック
        const o = this.ctx.createOscillator(), g = this.ctx.createGain();
        g.gain.value = 0; o.connect(g); g.connect(this.ctx.destination);
        o.start(); o.stop(this.ctx.currentTime + 0.01);
      } catch (e) { this.ctx = null; }
    }
    _tone(freq, durMs, type, delayMs) {
      if (!this.enabled || !this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const t0 = this.ctx.currentTime + (delayMs || 0) / 1000;
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(this.volume, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(t0); o.stop(t0 + durMs / 1000 + 0.02);
    }
    rep()    { this._tone(880, 90, 'sine'); }                       // rep成立
    depth()  { this._tone(1320, 60, 'sine'); }                      // 十分な深さに到達
    warn()   { this._tone(440, 120, 'triangle'); }                  // 軽い注意
    danger() { this._tone(220, 160, 'square'); this._tone(220, 160, 'square', 190); } // 危険（二連）
    lost()   { this._tone(330, 70, 'sine'); this._tone(247, 90, 'sine', 90); }        // 追跡ロスト
  }

  /* =======================================================================
   * 発話調停キュー
   *   優先度・TTL・最小間隔・同タグ置換を一元管理する。
   * ===================================================================== */
  class VoiceQueue {
    constructor(opts) {
      opts = opts || {};
      this.synth = opts.synth || global.speechSynthesis || null;
      this.lang = opts.lang || 'ja-JP';
      this.rate = opts.rate != null ? opts.rate : 1.12;   // 早口気味＝せかす
      this.pitch = opts.pitch != null ? opts.pitch : 0.85; // 低め＝威圧
      this.volume = opts.volume != null ? opts.volume : 1;
      this.minGapMs = opts.minGapMs != null ? opts.minGapMs : 700;
      this.maxQueue = opts.maxQueue != null ? opts.maxQueue : 2;
      this.enabled = opts.enabled !== false;
      this.now = opts.now || (() => (global.performance ? performance.now() : Date.now()));

      this._q = [];
      this._current = null;
      this._lastEndAt = -1e9;
      this._voice = null;
      this._unlocked = false;
      this._seq = 0;
      this._watchdog = null;

      if (this.synth && typeof this.synth.addEventListener === 'function') {
        this.synth.addEventListener('voiceschanged', () => this._pickVoice());
      }
      this._pickVoice();
    }

    _pickVoice() {
      if (!this.synth || !this.synth.getVoices) return;
      const vs = this.synth.getVoices() || [];
      if (!vs.length) return;
      const prefer = ['Kyoko', 'Otoya', 'Google 日本語', 'Microsoft Ayumi', 'Microsoft Nanami'];
      const ja = vs.filter(v => (v.lang || '').toLowerCase().indexOf('ja') === 0);
      for (const name of prefer) {
        const hit = ja.find(v => (v.name || '').indexOf(name) >= 0);
        if (hit) { this._voice = hit; return; }
      }
      this._voice = ja[0] || null;
    }

    /** iOS/Chrome のオーディオ制限解除。必ずユーザー操作のハンドラ内で呼ぶ。 */
    unlock() {
      if (!this.synth || this._unlocked) return;
      try {
        const u = new global.SpeechSynthesisUtterance('');
        u.volume = 0;
        this.synth.speak(u);
        this._unlocked = true;
        this._pickVoice();
      } catch (e) { /* 非対応環境は無視 */ }
    }

    /**
     * @param {string} text
     * @param {object} o  { priority, tag, ttlMs, interrupt }
     *   ttlMs: この時間内に喋り始められなければ破棄（古い指摘は害になる）
     */
    say(text, o) {
      if (!this.enabled || !this.synth || !text) return false;
      o = o || {};
      const t = this.now();
      const item = {
        seq: ++this._seq,
        text,
        priority: o.priority != null ? o.priority : PRIORITY.FORM,
        tag: o.tag || ('t' + this._seq),
        expireAt: t + (o.ttlMs != null ? o.ttlMs : 2200),
        interrupt: !!o.interrupt,
      };

      // 同タグは古い方を捨てて置き換える（同じ指摘を二度並べない）
      this._q = this._q.filter(x => x.tag !== item.tag);
      this._q.push(item);

      // 優先度降順 → 新しい順。溢れたら低優先を捨てる
      this._q.sort((a, b) => (b.priority - a.priority) || (b.seq - a.seq));
      if (this._q.length > this.maxQueue) this._q.length = this.maxQueue;

      if (item.interrupt && this._current && this._current.priority < item.priority) {
        this._abort();
      }
      this._pump();
      return true;
    }

    _abort() {
      if (!this._current) return;
      this._current = null;
      try { this.synth.cancel(); } catch (e) {}
      this._lastEndAt = this.now() - this.minGapMs; // 割り込み時は間を空けない
    }

    _pump() {
      if (!this.synth || this._current) return;
      const t = this.now();

      // TTL切れを破棄
      this._q = this._q.filter(x => x.expireAt > t);
      if (!this._q.length) return;

      const gap = t - this._lastEndAt;
      if (gap < this.minGapMs && this._q[0].priority < PRIORITY.DANGER) {
        setTimeout(() => this._pump(), this.minGapMs - gap + 10);
        return;
      }

      const item = this._q.shift();
      this._current = item;

      let u;
      try { u = new global.SpeechSynthesisUtterance(item.text); }
      catch (e) { this._current = null; return; }
      u.lang = this.lang;
      u.rate = this.rate;
      u.pitch = this.pitch;
      u.volume = this.volume;
      if (this._voice) u.voice = this._voice;

      const done = () => {
        if (this._current !== item) return;
        this._current = null;
        this._lastEndAt = this.now();
        clearTimeout(this._watchdog);
        this._pump();
      };
      u.onend = done;
      u.onerror = done;

      // 一部ブラウザで onend が来ないことがあるので保険
      clearTimeout(this._watchdog);
      this._watchdog = setTimeout(done, 5000);

      try { this.synth.speak(u); }
      catch (e) { done(); }
    }

    clear() {
      this._q = [];
      this._abort();
    }
    setEnabled(v) { this.enabled = !!v; if (!v) this.clear(); }
  }

  /* =======================================================================
   * FormCoach —  エンジン出力 → 音・声 への変換
   * ===================================================================== */
  class FormCoach {
    constructor(engine, opts) {
      opts = opts || {};
      this.engine = engine;
      this.voice = opts.voice || new VoiceQueue(opts.voiceOptions);
      this.beeper = opts.beeper || new Beeper(opts.beeperOptions);

      this.announceCount = opts.announceCount !== false;  // rep数を読み上げる
      this.alertsPerRep = opts.alertsPerRep != null ? opts.alertsPerRep : 2;
      this.escalateAt = opts.escalateAt != null ? opts.escalateAt : 3;
      this.restMs = opts.restMs != null ? opts.restMs : 7000;   // セット終了とみなす無動作時間
      this.lostGraceMs = opts.lostGraceMs != null ? opts.lostGraceMs : 1500;
      this.now = opts.now || (() => (global.performance ? performance.now() : Date.now()));

      this.onSetComplete = opts.onSetComplete || null;  // ← Phase 3 の接続点
      this.onEvent = opts.onEvent || null;              // UI表示用フック

      this._reset();

      // フレームが来なくなってもセットを締められるように監視する
      // （カメラ停止・離席・タブ非表示でも要約を出すため）
      this._watch = null;
      if (opts.autoCloseSet !== false && typeof setInterval === 'function') {
        this._watch = setInterval(() => this._maybeCloseSet(this.now()), 500);
      }
    }

    /** 撮影条件が崩れている間など、計測を一時停止する。
     *  休憩タイマが進んでしまい、立ち位置を直しているだけでセットが
     *  締まってしまうのを防ぐ。停止していた時間はセット所要から除く。 */
    pause() {
      if (this._paused != null) return;
      this._paused = this.now();
    }
    resume() {
      if (this._paused == null) return;
      const d = this.now() - this._paused;
      if (this._lastRepAt != null) this._lastRepAt += d;
      if (this.set.startedAt != null) this.set.startedAt += d;
      this._paused = null;
    }

    /** 監視タイマを止める（画面破棄時に呼ぶ） */
    dispose() {
      if (this._watch) { clearInterval(this._watch); this._watch = null; }
      this.voice.clear();
    }

    _reset() {
      this.set = { startedAt: null, reps: [], tagCounts: {} };
      this._alertsThisRep = 0;
      this._lastRepAt = null;
      this._lostSince = null;
      this._lostAnnounced = false;
      this._calibAnnounced = false;
      this._readyAnnounced = false;
      this._depthChimed = false;
      this._setClosed = false;
      this._saidCounts = {};
      this._paused = null;
    }

    /** ユーザー操作のハンドラから呼ぶ（iOSのオーディオ制限解除） */
    unlock() {
      this.voice.unlock();
      this.beeper.unlock();
    }

    startSet() {
      this.voice.clear();
      this._reset();
      this.set.startedAt = this.now();
      this.engine.reset();
    }

    /** 現在のセットを締めて要約を返す（Phase 3 へ渡す素材） */
    endSet() {
      if (this._setClosed) return null;
      this._setClosed = true;
      const s = this.summary();
      if (this.onSetComplete) { try { this.onSetComplete(s); } catch (e) {} }
      this._emit('setComplete', s);
      return s;
    }

    summary() {
      const reps = this.set.reps;
      const avg = (k) => {
        const v = reps.map(r => r[k]).filter(x => x != null);
        return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
      };
      return {
        exercise: this.engine.def.id,
        exerciseLabel: this.engine.def.label,
        view: this.engine.view,
        repCount: reps.length,
        durationMs: this.set.startedAt != null ? Math.round(this.now() - this.set.startedAt) : null,
        avgRomPercent: avg('romPercent'),
        avgEccentricMs: avg('eccentricMs'),
        avgConcentricMs: avg('concentricMs'),
        romTrend: reps.map(r => r.romPercent),
        faultTotals: Object.keys(this.set.tagCounts).map(k => ({ id: k, reps: this.set.tagCounts[k] })),
        reps: reps,
      };
    }

    _emit(type, payload) {
      if (this.onEvent) { try { this.onEvent(type, payload); } catch (e) {} }
    }

    /** エンジンの update() 戻り値を毎フレーム渡す */
    handle(out) {
      if (!out) return;
      const t = this.now();

      /* --- 追跡ロスト --- */
      if (!out.ok) {
        if (this._lostSince == null) this._lostSince = t;
        if (!this._lostAnnounced && t - this._lostSince > this.lostGraceMs) {
          this._lostAnnounced = true;
          this.beeper.lost();
          this.voice.say('体が画面に入っていない。位置を直せ。',
            { priority: PRIORITY.FORM, tag: 'lost', ttlMs: 4000 });
          this._emit('trackingLost', out.tracking);
        }
        this._maybeCloseSet(t);
        return;                                  // ロスト中はフォーム指摘を一切出さない
      }
      if (this._lostSince != null) {
        this._lostSince = null;
        this._lostAnnounced = false;
      }

      /* --- キャリブレーション --- */
      if (out.calibrating) {
        if (!this._calibAnnounced) {
          this._calibAnnounced = true;
          this.voice.say('そのまま直立しろ。基準を取る。',
            { priority: PRIORITY.COUNT, tag: 'calib', ttlMs: 3000 });
          this._emit('calibrating', null);
        }
        return;
      }
      if (this._calibAnnounced && !this._readyAnnounced) {
        this._readyAnnounced = true;
        this.beeper.depth();
        this.voice.say('始めろ。', { priority: PRIORITY.COUNT, tag: 'ready', ttlMs: 2000 });
        this._emit('ready', null);
      }
      if (this.set.startedAt == null) this.set.startedAt = t;

      /* --- 深さ到達のチャイム（声より速い非言語フィードバック） --- */
      if (out.phase === 'bottom' && !this._depthChimed) {
        this._depthChimed = true;
        this.beeper.depth();
      } else if (out.phase === 'top') {
        this._depthChimed = false;
      }

      /* --- 逸脱の指摘 --- */
      for (const a of (out.alerts || [])) {
        this._speakAlert(a, t);
      }

      /* --- rep完了 --- */
      if (out.repCompleted) {
        const rep = out.repCompleted;
        this.set.reps.push(rep);
        this._lastRepAt = t;
        this._alertsThisRep = 0;
        this._setClosed = false;

        for (const v of rep.violations) {
          this.set.tagCounts[v.id] = (this.set.tagCounts[v.id] || 0) + 1;
        }
        this.beeper.rep();
        if (this.announceCount) {
          // 最優先ではない。フォーム指摘が待っていればこれは捨てられる
          this.voice.say(String(rep.index), { priority: PRIORITY.COUNT, tag: 'count', ttlMs: 1100 });
        }
        this._emit('rep', rep);
      }

      this._maybeCloseSet(t);
    }

    _speakAlert(a, t) {
      const danger = a.level === 'danger';

      if (!danger && this._alertsThisRep >= this.alertsPerRep) return;  // 言い過ぎない
      this._alertsThisRep++;

      // 同じ欠点を繰り返し指摘するときは言い方を強める（「言った回数」で数える）
      const n = (this._saidCounts[a.id] = (this._saidCounts[a.id] || 0) + 1);
      let text = a.message;
      if (!danger && this.escalateAt > 0 && n >= this.escalateAt) {
        text = '何度も言わせるな。' + text;
      }

      if (danger) this.beeper.danger(); else this.beeper.warn();

      this.voice.say(text, {
        priority: danger ? PRIORITY.DANGER : PRIORITY.FORM,
        tag: 'a:' + a.id,
        // 動作中の指摘は鮮度が命。rep完了時の講評は少し長く持たせる
        ttlMs: a.timing === 'endOfRep' ? 2600 : 1400,
        interrupt: danger,
      });
      this._emit('alert', a);
    }

    _maybeCloseSet(t) {
      if (this._setClosed || this._paused != null) return;
      if (!this.set.reps.length) return;
      if (this._lastRepAt == null) return;
      if (t - this._lastRepAt < this.restMs) return;
      const s = this.endSet();
      if (s) {
        this.voice.say(`${s.repCount}レップ。平均可動域${s.avgRomPercent}パーセント。`,
          { priority: PRIORITY.COUNT, tag: 'summary', ttlMs: 6000 });
      }
    }
  }

  const api = { FormCoach, VoiceQueue, Beeper, PRIORITY };
  global.FormCoach = FormCoach;
  global.VoiceQueue = VoiceQueue;
  global.Beeper = Beeper;
  global.FormCoachKit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
