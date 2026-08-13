/* =========================================================================
 * form-engine.js  —  筋トレフォーム解析エンジン（即時層 / ルールベース）
 * -------------------------------------------------------------------------
 *  Phase 1: 角度取得・rep計数・チェックポイント判定を種目別ルールJSONに外出し
 *
 *  依存なし。MediaPipe Pose の landmarks 配列を毎フレーム渡すだけ。
 *
 *      const engine = new FormEngine('squat', { view: 'front' });
 *      engine.setAspect(video.videoWidth, video.videoHeight);
 *      const out = engine.update(results.poseLandmarks, performance.now());
 *
 *  設計方針:
 *   - JSONに式や関数文字列を持たせない（evalを使わない）。
 *     メトリクスは「型 + 参照点」の宣言。評価器はエンジン側に固定実装。
 *   - 追跡が怪しいときは黙る。誤検知で怪我を誘発しない方を常に優先。
 *   - カメラアングルで測れない指標は自動的に無効化する。
 *   - 深さ・テンポ等の「1rep終わらないと判断できないもの」は repChecks で扱う。
 * ========================================================================= */

(function (global) {
  'use strict';

  const LM = {
    nose: 0,
    leftEar: 7, rightEar: 8,
    leftShoulder: 11, rightShoulder: 12,
    leftElbow: 13, rightElbow: 14,
    leftWrist: 15, rightWrist: 16,
    leftHip: 23, rightHip: 24,
    leftKnee: 25, rightKnee: 26,
    leftAnkle: 27, rightAnkle: 28,
    leftHeel: 29, rightHeel: 30,
    leftFoot: 31, rightFoot: 32,
  };

  const PHASE = {
    IDLE: 'idle',
    CALIBRATING: 'calibrating',
    TOP: 'top',
    DESCENDING: 'descending',
    BOTTOM: 'bottom',
    ASCENDING: 'ascending',
  };

  /* =======================================================================
   * 種目定義（ルールJSON本体）
   *
   *  metrics[]     計測量の宣言
   *  rep           rep計数の定義。byView でカメラアングル別に切替可
   *  checkpoints[] 毎フレーム判定するフォームルール
   *  repChecks[]   1rep完了時に判定するルール（深さ・テンポなど）
   *
   *  message のトーンはストイック・簡潔・命令形で統一
   * ===================================================================== */
  const EXERCISES = {

    /* ------------------------------ スクワット ------------------------------ */
    squat: {
      id: 'squat',
      label: 'スクワット',
      recommendedView: 'front',
      supportedViews: ['front', 'side'],
      viewHint: {
        front: '正面から腰の高さで撮影。膝の内側の崩れを見る。',
        side: '真横から腰の高さで撮影。深さと上体の角度を見る。',
      },
      metrics: [
        { id: 'kneeAngle', type: 'angle', points: ['hip', 'knee', 'ankle'], side: 'auto' },
        { id: 'hipAngle', type: 'angle', points: ['shoulder', 'hip', 'knee'], side: 'auto' },
        { id: 'hipHeight', type: 'segmentRatio', from: 'hip', to: 'ankle', side: 'auto', normalizeBy: 'torso' },
        { id: 'trunkLean', type: 'leanFromVertical', from: 'hip', to: 'shoulder', side: 'mid' },
        { id: 'valgusL', type: 'medialDeviation', joint: 'knee', from: 'hip', to: 'ankle', side: 'left' },
        { id: 'valgusR', type: 'medialDeviation', joint: 'knee', from: 'hip', to: 'ankle', side: 'right' },
        { id: 'kneeAsym', type: 'lrDifference', of: 'angle', points: ['hip', 'knee', 'ankle'] },
        { id: 'heelLift', type: 'verticalGap', a: 'heel', b: 'foot', side: 'auto', normalizeBy: 'torso' },
      ],
      rep: {
        byView: {
          // 側面視: 膝の屈曲角がそのまま使える
          side: {
            metric: 'kneeAngle', top: 168, bottom: 90,
            direction: 'decreasing', minRepMs: 700, minProgress: 0.35,
          },
          // 正面視: 膝角度は矢状面の動きなのでほぼ変化しない。
          //         股関節-足首距離／体幹長 の縮みで沈み込みを取る（要キャリブレーション）
          front: {
            metric: 'hipHeight',
            autoTop: { bottomFactor: 0.72, sampleMs: 1200 },
            direction: 'decreasing', minRepMs: 700, minProgress: 0.35,
          },
        },
      },
      checkpoints: [
        {
          id: 'trunkLean', metric: 'trunkLean', phases: ['descending', 'bottom', 'ascending'], view: 'side',
          warn: { op: '>', value: 45 }, danger: { op: '>', value: 60 },
          strikes: 5, cooldownMs: 4000,
          message: { warn: '上体が倒れている。胸を張れ。', danger: '前傾しすぎだ。重量を落とせ。' },
        },
        {
          id: 'valgusL', metric: 'valgusL', phases: ['descending', 'bottom', 'ascending'], view: 'front',
          warn: { op: '>', value: 0.10 }, danger: { op: '>', value: 0.18 },
          strikes: 4, cooldownMs: 3500,
          message: { warn: '左膝が内に入っている。外へ割れ。', danger: '左膝が潰れている。止めろ。' },
        },
        {
          id: 'valgusR', metric: 'valgusR', phases: ['descending', 'bottom', 'ascending'], view: 'front',
          warn: { op: '>', value: 0.10 }, danger: { op: '>', value: 0.18 },
          strikes: 4, cooldownMs: 3500,
          message: { warn: '右膝が内に入っている。外へ割れ。', danger: '右膝が潰れている。止めろ。' },
        },
        {
          id: 'asymmetry', metric: 'kneeAsym', phases: ['bottom'], view: 'front',
          warn: { op: '>', value: 15 },
          strikes: 5, cooldownMs: 6000,
          message: { warn: '左右差が出ている。均等に沈め。' },
        },
        {
          id: 'heelLift', metric: 'heelLift', phases: ['bottom'], view: 'side',
          warn: { op: '>', value: 0.035 },
          strikes: 6, cooldownMs: 6000,
          message: { warn: '踵が浮いている。足裏全体で踏め。' },
        },
      ],
      repChecks: [
        {
          id: 'depth', field: 'romPercent',
          warn: { op: '<', value: 82 }, danger: { op: '<', value: 60 },
          message: { warn: '浅い。もう一段落とせ。', danger: '可動域が全く足りていない。' },
          cooldownMs: 4000,
        },
        {
          id: 'tempo', field: 'eccentricMs',
          warn: { op: '<', value: 550 },
          message: { warn: '落ちるのが速い。ネガティブを効かせろ。' },
          cooldownMs: 8000,
        },
      ],
    },

    /* ------------------------------ デッドリフト ----------------------------- */
    /* 脊柱の丸まりは MediaPipe に胸腰椎の点が無いため直接測定不能。
       hipAngle・体幹角を代理指標とし、閾値は保守的に置く。 */
    deadlift: {
      id: 'deadlift',
      label: 'デッドリフト',
      recommendedView: 'side',
      supportedViews: ['side'],
      viewHint: { side: '真横から腰の高さで撮影。全身とバーが入る画角にすること。' },
      safetyNote: '脊柱の丸まりは推定精度が低い。警告が出ないことは安全を意味しない。',
      metrics: [
        { id: 'hipAngle', type: 'angle', points: ['shoulder', 'hip', 'knee'], side: 'auto' },
        { id: 'kneeAngle', type: 'angle', points: ['hip', 'knee', 'ankle'], side: 'auto' },
        { id: 'trunkLean', type: 'leanFromVertical', from: 'hip', to: 'shoulder', side: 'mid' },
        { id: 'hipRiseRatio', type: 'riseRatio', a: 'hip', b: 'shoulder', windowMs: 350 },
        { id: 'barDrift', type: 'horizontalDrift', point: 'wrist', side: 'auto', normalizeBy: 'torso' },
      ],
      rep: {
        metric: 'hipAngle', top: 168, bottom: 85,
        direction: 'decreasing', minRepMs: 900, minProgress: 0.35,
      },
      checkpoints: [
        {
          id: 'hipShoot', metric: 'hipRiseRatio', phases: ['ascending'], view: 'side',
          warn: { op: '>', value: 1.6 }, danger: { op: '>', value: 2.4 },
          strikes: 3, cooldownMs: 4000,
          message: { warn: '尻だけが先に上がっている。胸で引け。', danger: '腰が抜けている。中断しろ。' },
        },
        {
          id: 'barDrift', metric: 'barDrift', phases: ['ascending', 'descending'], view: 'side',
          warn: { op: '>', value: 0.12 },
          strikes: 5, cooldownMs: 5000,
          message: { warn: 'バーが体から離れている。脛に沿わせろ。' },
        },
        {
          id: 'lockout', metric: 'hipAngle', phases: ['top'], view: 'side',
          warn: { op: '<', value: 160 },
          strikes: 5, cooldownMs: 6000,
          message: { warn: 'ロックアウトが甘い。股関節を締め切れ。' },
        },
      ],
      repChecks: [
        {
          id: 'rom', field: 'romPercent',
          warn: { op: '<', value: 80 },
          message: { warn: '引き切れていない。床から一直線まで。' },
          cooldownMs: 5000,
        },
      ],
    },

    /* ------------------------------- 腕立て伏せ ------------------------------ */
    pushup: {
      id: 'pushup',
      label: '腕立て伏せ',
      recommendedView: 'side',
      supportedViews: ['side'],
      viewHint: { side: '真横から床すれすれの高さで撮影。頭から踵まで入れる。' },
      metrics: [
        { id: 'elbowAngle', type: 'angle', points: ['shoulder', 'elbow', 'wrist'], side: 'auto' },
        { id: 'hipSag', type: 'lineDeviation', joint: 'hip', from: 'shoulder', to: 'ankle', side: 'auto', normalizeBy: 'torso' },
      ],
      rep: {
        metric: 'elbowAngle', top: 160, bottom: 90,
        direction: 'decreasing', minRepMs: 600, minProgress: 0.35,
      },
      checkpoints: [
        {
          id: 'hipSag', metric: 'hipSag', phases: ['descending', 'bottom', 'ascending'], view: 'side',
          warn: { op: '>', value: 0.08 }, danger: { op: '>', value: 0.15 },
          strikes: 5, cooldownMs: 4000,
          message: { warn: '腰が落ちている。腹を締めろ。', danger: '体幹が抜けている。膝つきに切り替えろ。' },
        },
        {
          id: 'hipPike', metric: 'hipSag', phases: ['descending', 'bottom', 'ascending'], view: 'side',
          warn: { op: '<', value: -0.09 },
          strikes: 5, cooldownMs: 5000,
          message: { warn: '尻が上がっている。一直線を保て。' },
        },
      ],
      repChecks: [
        {
          id: 'depth', field: 'romPercent',
          warn: { op: '<', value: 85 },
          message: { warn: '可動域が足りない。胸を床まで。' },
          cooldownMs: 4000,
        },
      ],
    },
  };

  /* =======================================================================
   * 幾何ユーティリティ
   * ===================================================================== */
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function rawPoint(lms, name, side) {
    if (name === 'nose') {
      const p = lms[LM.nose];
      return p ? { x: p.x, y: p.y, v: p.visibility != null ? p.visibility : 1 } : null;
    }
    if (side === 'mid') {
      const l = rawPoint(lms, name, 'left');
      const r = rawPoint(lms, name, 'right');
      if (!l || !r) return null;
      // 側面視では反対側が必ず低可視性になるため min ではなく平均を採る
      return { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2, v: (l.v + r.v) / 2 };
    }
    const idx = LM[side + cap(name)];
    if (idx === undefined) return null;
    const p = lms[idx];
    if (!p) return null;
    return { x: p.x, y: p.y, v: p.visibility != null ? p.visibility : 1 };
  }

  // 正規化座標は縦横比が潰れている。x にアスペクト比を掛けて実空間比に戻す
  function project(p, aspect) {
    return p ? { x: p.x * aspect, y: p.y, v: p.v } : null;
  }

  function angleAt(a, b, c) {
    if (!a || !b || !c) return null;
    const v1x = a.x - b.x, v1y = a.y - b.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const d = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
    if (d < 1e-6) return null;
    let cos = (v1x * v2x + v1y * v2y) / d;
    cos = Math.max(-1, Math.min(1, cos));
    return Math.acos(cos) * 180 / Math.PI;
  }

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  /* =======================================================================
   * メトリクス評価器  →  { value, visibility } / 測定不能なら null
   * ===================================================================== */
  const EVALUATORS = {

    angle(def, ctx) {
      const s = ctx.resolveSide(def.side);
      const pts = def.points.map(n => ctx.P(n, s));
      if (pts.some(p => !p)) return null;
      const a = angleAt(pts[0], pts[1], pts[2]);
      if (a == null) return null;
      return { value: a, visibility: Math.min.apply(null, pts.map(p => p.v)) };
    },

    lrDifference(def, ctx) {
      const l = def.points.map(n => ctx.P(n, 'left'));
      const r = def.points.map(n => ctx.P(n, 'right'));
      if (l.some(p => !p) || r.some(p => !p)) return null;
      const al = angleAt(l[0], l[1], l[2]), ar = angleAt(r[0], r[1], r[2]);
      if (al == null || ar == null) return null;
      return {
        value: Math.abs(al - ar),
        visibility: Math.min.apply(null, l.map(p => p.v).concat(r.map(p => p.v))),
      };
    },

    // 2点間距離 ÷ 基準長。カメラ距離に依存しない「沈み込み」指標
    segmentRatio(def, ctx) {
      const s = ctx.resolveSide(def.side);
      const a = ctx.P(def.from, s), b = ctx.P(def.to, s);
      const norm = ctx.normalizer(def.normalizeBy);
      if (!a || !b || !norm) return null;
      return { value: dist(a, b) / norm, visibility: Math.min(a.v, b.v) };
    },

    // 鉛直からの傾き（度）。0 = 直立
    leanFromVertical(def, ctx) {
      const a = ctx.P(def.from, def.side || 'mid');
      const b = ctx.P(def.to, def.side || 'mid');
      if (!a || !b) return null;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.hypot(dx, dy) < 1e-6) return null;
      return { value: Math.abs(Math.atan2(dx, -dy) * 180 / Math.PI), visibility: Math.min(a.v, b.v) };
    },

    // 膝の内側偏位。正 = 内に入っている。正面視でのみ有効（側面では自動的にnull）
    medialDeviation(def, ctx) {
      const side = def.side;
      const joint = ctx.P(def.joint, side);
      const from = ctx.P(def.from, side);
      const to = ctx.P(def.to, side);
      const hipMid = ctx.P('hip', 'mid');
      const hipW = ctx.hipWidth();
      if (!joint || !from || !to || !hipMid || hipW == null) return null;
      if (hipW < 0.04) return null;                 // 側面視 → 測定不能
      const span = to.y - from.y;
      if (Math.abs(span) < 1e-6) return null;
      const t = (joint.y - from.y) / span;
      const lineX = from.x + (to.x - from.x) * t;
      const lateralSign = from.x > hipMid.x ? 1 : -1;
      return {
        value: (lateralSign * (lineX - joint.x)) / hipW,
        visibility: Math.min(joint.v, from.v, to.v),
      };
    },

    // 2点を結ぶ直線からの垂直方向のズレ。正 = 下に落ちている
    lineDeviation(def, ctx) {
      const s = ctx.resolveSide(def.side);
      const joint = ctx.P(def.joint, s);
      const from = ctx.P(def.from, s);
      const to = ctx.P(def.to, s);
      const norm = ctx.normalizer(def.normalizeBy);
      if (!joint || !from || !to || !norm) return null;
      const span = to.x - from.x;
      if (Math.abs(span) < 1e-6) return null;
      const t = (joint.x - from.x) / span;
      const lineY = from.y + (to.y - from.y) * t;
      return { value: (joint.y - lineY) / norm, visibility: Math.min(joint.v, from.v, to.v) };
    },

    verticalGap(def, ctx) {
      const s = ctx.resolveSide(def.side);
      const a = ctx.P(def.a, s), b = ctx.P(def.b, s);
      const norm = ctx.normalizer(def.normalizeBy);
      if (!a || !b || !norm) return null;
      return { value: (b.y - a.y) / norm, visibility: Math.min(a.v, b.v) };
    },

    horizontalDrift(def, ctx) {
      const s = ctx.resolveSide(def.side);
      const p = ctx.P(def.point, s);
      const norm = ctx.normalizer(def.normalizeBy);
      if (!p || !norm) return null;
      const base = ctx.baseline(def.point + ':' + s, p.x);
      return { value: Math.abs(p.x - base) / norm, visibility: p.v };
    },

    // 時間窓内の上昇速度比（デッドリフトの尻先行検出）
    riseRatio(def, ctx) {
      const s = ctx.resolveSide('auto');
      const a = ctx.P(def.a, s), b = ctx.P(def.b, s);
      if (!a || !b) return null;
      const past = ctx.history(def.windowMs || 350);
      if (!past) return null;
      const pa = past.pts[def.a], pb = past.pts[def.b];
      if (pa == null || pb == null) return null;
      const da = pa - a.y, db = pb - b.y;   // y下向き正 → 上昇で正
      const vis = Math.min(a.v, b.v);
      if (da <= 0.002) return { value: 0, visibility: vis };
      if (Math.abs(db) < 0.002) return { value: 3, visibility: vis };
      return { value: da / db, visibility: vis };
    },
  };

  function compare(v, cond) {
    return cond.op === '>' ? v > cond.value : v < cond.value;
  }

  /* =======================================================================
   * エンジン本体
   * ===================================================================== */
  class FormEngine {
    constructor(exerciseId, options) {
      const def = EXERCISES[exerciseId];
      if (!def) throw new Error('未定義の種目: ' + exerciseId);
      const o = options || {};
      this.def = def;
      this.view = o.view || def.recommendedView;
      this.aspect = o.aspect || 1;
      this.minVisibility = o.minVisibility != null ? o.minVisibility : 0.55;
      this.smoothing = o.smoothing != null ? o.smoothing : 0.35;
      this.lostFramesLimit = o.lostFramesLimit != null ? o.lostFramesLimit : 5;
      this.reset();
    }

    reset() {
      this.smoothed = {};
      this.phase = PHASE.IDLE;
      this.repCount = 0;
      this.lostFrames = 0;
      this.lastRep = null;
      this._strikes = {};
      this._lastFired = {};
      this._baselines = {};
      this._hist = [];
      this._lastProgress = null;
      this._progress = 0;
      this._bottomReached = false;
      this._repStartT = null;
      this._bottomT = null;
      this._repExtreme = 0;
      this._extremeT = null;
      this._repViolations = {};
      this._calib = null;
      this._repRange = null;
    }

    setAspect(width, height) {
      this.aspect = (width && height) ? (width / height) : 1;
    }

    setView(view) { this.view = view; this._strikes = {}; this._calib = null; this._repRange = null; }

    setExercise(exerciseId, view) {
      const def = EXERCISES[exerciseId];
      if (!def) throw new Error('未定義の種目: ' + exerciseId);
      this.def = def;
      this.view = view || def.recommendedView;
      this.reset();
    }

    get repDef() {
      const r = this.def.rep;
      return (r.byView ? (r.byView[this.view] || r.byView[this.def.recommendedView]) : r);
    }

    get isCalibrating() { return !!(this._calib && this._calib.active); }

    recalibrate() { this._calib = null; this._repRange = null; }

    /* --- 毎フレーム呼ぶ ---
     * @param {object} [opts] { metrics, trackingOk }
     *   計測済みのメトリクスを渡すと、その計算を丸ごと省略する。
     *   同じ映像に閾値だけ変えて当て直す用途（調整ベンチ・ログ再生）で使う。 */
    update(landmarks, timestamp, opts) {
      const t = timestamp != null ? timestamp : Date.now();
      let metrics;

      if (opts && opts.metrics) {
        if (opts.trackingOk === false) return this._lost('cached_lost', t);
        metrics = opts.metrics;
        this.lostFrames = 0;
      } else {
        if (!landmarks || landmarks.length < 33) return this._lost('no_landmarks', t);

        const ctx = this._buildContext(landmarks, t);
        if (ctx.coreVisibility < this.minVisibility) return this._lost('low_visibility', t);
        this.lostFrames = 0;

        metrics = {};
        for (const mdef of this.def.metrics) {
          let r = null;
          try { r = EVALUATORS[mdef.type] ? EVALUATORS[mdef.type](mdef, ctx) : null; }
          catch (e) { r = null; }
          if (!r || r.value == null || !isFinite(r.value) || r.visibility < this.minVisibility) {
            metrics[mdef.id] = null;
            continue;
          }
          const prev = this.smoothed[mdef.id];
          const v = (prev == null) ? r.value : prev + this.smoothing * (r.value - prev);
          this.smoothed[mdef.id] = v;
          metrics[mdef.id] = v;
        }
        this._pushHistory(ctx, t);
      }

      // キャリブレーション中は計数も指摘もしない
      if (this._needCalibration(metrics, t)) {
        this.phase = PHASE.CALIBRATING;
        return {
          ok: true, exercise: this.def.id, view: this.view, phase: this.phase,
          repCount: this.repCount, progress: 0, metrics, alerts: [],
          repCompleted: null, calibrating: true,
          tracking: { ok: true },
        };
      }

      const repEvent = this._updateRepState(metrics, t);
      metrics.repProgress = this._progress;

      let alerts = this._evaluateCheckpoints(metrics, t);
      if (repEvent) alerts = alerts.concat(this._evaluateRepChecks(repEvent, t));

      return {
        ok: true, exercise: this.def.id, view: this.view, phase: this.phase,
        repCount: this.repCount, progress: this._progress, metrics,
        alerts: alerts.slice(0, 1), allAlerts: alerts,
        repCompleted: repEvent, calibrating: false,
        tracking: { ok: true },
      };
    }

    _lost(reason, t) {
      this.lostFrames++;
      if (this.lostFrames > this.lostFramesLimit) { this._strikes = {}; this.phase = PHASE.IDLE; }
      return {
        ok: false, exercise: this.def.id, view: this.view, phase: this.phase,
        repCount: this.repCount, progress: this._progress, metrics: {},
        alerts: [], repCompleted: null, calibrating: false,
        tracking: { ok: false, reason },
      };
    }

    _buildContext(lms, t) {
      const self = this, A = this.aspect, cache = {};
      const P = (name, side) => {
        const key = name + ':' + side;
        if (!(key in cache)) cache[key] = project(rawPoint(lms, name, side), A);
        return cache[key];
      };
      const ls = P('shoulder', 'left'), rs = P('shoulder', 'right');
      const lh = P('hip', 'left'), rh = P('hip', 'right');
      let auto = 'left';
      if (ls && rs && lh && rh) auto = (ls.v + lh.v) >= (rs.v + rh.v) ? 'left' : 'right';

      const shoulderMid = P('shoulder', 'mid'), hipMid = P('hip', 'mid');
      const torso = (shoulderMid && hipMid) ? dist(shoulderMid, hipMid) : null;
      // 側面視を成立させるため「肩が片方 + 腰が片方」見えていればよい
      const coreVis = Math.min(
        Math.max(ls ? ls.v : 0, rs ? rs.v : 0),
        Math.max(lh ? lh.v : 0, rh ? rh.v : 0)
      );

      return {
        P,
        coreVisibility: coreVis,
        resolveSide: (s) => (!s || s === 'auto') ? auto : s,
        hipWidth: () => (lh && rh) ? Math.abs(lh.x - rh.x) : null,
        normalizer: (kind) => {
          if (kind === 'torso') return (torso && torso > 0.02) ? torso : null;
          if (kind === 'hipWidth') { const w = (lh && rh) ? Math.abs(lh.x - rh.x) : null; return (w && w > 0.02) ? w : null; }
          return 1;
        },
        baseline: (key, val) => {
          if (self._baselines[key] == null) self._baselines[key] = val;
          return self._baselines[key];
        },
        history: (windowMs) => {
          const target = t - windowMs;
          for (let i = self._hist.length - 1; i >= 0; i--) if (self._hist[i].t <= target) return self._hist[i];
          return null;
        },
      };
    }

    _pushHistory(ctx, t) {
      const s = ctx.resolveSide('auto');
      const pts = {};
      for (const k of ['hip', 'shoulder', 'knee', 'wrist']) {
        const p = ctx.P(k, (k === 'hip' || k === 'shoulder') ? 'mid' : s);
        pts[k] = p ? p.y : null;
      }
      this._hist.push({ t, pts });
      while (this._hist.length && t - this._hist[0].t > 1500) this._hist.shift();
    }

    /* --- 自動キャリブレーション（立位を1秒ほどサンプリングして上端を決める） --- */
    _needCalibration(metrics, t) {
      const r = this.repDef;
      if (!r.autoTop) {
        this._repRange = { top: r.top, bottom: r.bottom };
        return false;
      }
      if (this._repRange) return false;
      const v = metrics[r.metric];
      if (v == null) return true;
      if (!this._calib) this._calib = { active: true, until: t + (r.autoTop.sampleMs || 1200), max: v, n: 0 };
      this._calib.max = Math.max(this._calib.max, v);
      this._calib.n++;
      if (t >= this._calib.until && this._calib.n >= 10) {
        const top = this._calib.max;
        this._repRange = { top, bottom: top * r.autoTop.bottomFactor };
        this._calib.active = false;
        return false;
      }
      return true;
    }

    /* --- rep状態機械 --- */
    _updateRepState(metrics, t) {
      const r = this.repDef;
      const range = this._repRange;
      const v = metrics[r.metric];
      if (v == null || !range) return null;

      const span = range.top - range.bottom;
      if (Math.abs(span) < 1e-6) return null;
      let progress = (r.direction === 'decreasing')
        ? (range.top - v) / span
        : (v - range.bottom) / span;
      progress = Math.max(0, Math.min(1.3, progress));
      this._progress = progress;

      const prev = this._lastProgress;
      this._lastProgress = progress;
      const delta = (prev == null) ? 0 : progress - prev;

      if (progress > this._repExtreme) { this._repExtreme = progress; this._extremeT = t; }

      const TOP_T = 0.12, BOTTOM_PHASE_T = 0.78, MOVE = 0.004;
      const MIN_PROGRESS = r.minProgress != null ? r.minProgress : 0.5;
      let completed = null;

      if (progress < TOP_T) {
        if (this._bottomReached && this.phase !== PHASE.TOP) {
          const dur = this._repStartT != null ? t - this._repStartT : 0;
          if (dur >= (r.minRepMs || 500)) {
            this.repCount++;
            completed = {
              index: this.repCount,
              durationMs: Math.round(dur),
              eccentricMs: this._extremeT != null && this._repStartT != null ? Math.round(this._extremeT - this._repStartT) : null,
              concentricMs: this._extremeT != null ? Math.round(t - this._extremeT) : null,
              romPercent: Math.round(Math.min(this._repExtreme, 1.2) * 100),
              violations: Object.keys(this._repViolations).map(k => ({
                id: k,
                count: this._repViolations[k].count,
                worst: Number(this._repViolations[k].worst.toFixed(3)),
                level: this._repViolations[k].level,
              })),
            };
            this.lastRep = completed;
          }
          this._bottomReached = false;
          this._repExtreme = 0;
          this._extremeT = null;
          this._repViolations = {};
          this._repStartT = null;
          this._bottomT = null;
        }
        this.phase = PHASE.TOP;
      } else {
        if (progress >= MIN_PROGRESS && !this._bottomReached) this._bottomReached = true;
        if (progress > BOTTOM_PHASE_T) {
          this.phase = PHASE.BOTTOM;
        } else if (delta > MOVE) {
          if (this.phase === PHASE.TOP || this.phase === PHASE.IDLE || this.phase === PHASE.CALIBRATING) {
            this._repStartT = t;
            this._repExtreme = progress;
            this._extremeT = t;
            this._repViolations = {};
          }
          this.phase = PHASE.DESCENDING;
        } else if (delta < -MOVE) {
          this.phase = PHASE.ASCENDING;
        }
      }
      if (this._repStartT == null && this.phase === PHASE.DESCENDING) this._repStartT = t;
      return completed;
    }

    _evaluateCheckpoints(metrics, t) {
      const alerts = [];
      for (const cp of this.def.checkpoints) {
        const cpView = cp.view || 'any';
        if (cpView !== 'any' && cpView !== this.view) { this._strikes[cp.id] = 0; continue; }
        if (cp.phases && cp.phases.indexOf(this.phase) === -1) { this._strikes[cp.id] = 0; continue; }

        const v = metrics[cp.metric];
        if (v == null) { this._strikes[cp.id] = 0; continue; }

        let level = null;
        if (cp.danger && compare(v, cp.danger)) level = 'danger';
        else if (cp.warn && compare(v, cp.warn)) level = 'warn';
        if (!level) { this._strikes[cp.id] = 0; continue; }

        // rep単位で記録（Phase 3 でClaudeに渡す素材になる）
        const rec = this._repViolations[cp.id] || { count: 0, worst: 0, level: 'warn' };
        rec.count++;
        if (Math.abs(v) > Math.abs(rec.worst)) rec.worst = v;
        if (level === 'danger') rec.level = 'danger';
        this._repViolations[cp.id] = rec;

        this._strikes[cp.id] = (this._strikes[cp.id] || 0) + 1;
        if (this._strikes[cp.id] < (cp.strikes || 3)) continue;

        const last = this._lastFired[cp.id];
        if (last != null && t - last < (cp.cooldownMs || 3000)) continue;
        this._lastFired[cp.id] = t;

        alerts.push({
          id: cp.id, level, metric: cp.metric, value: Number(v.toFixed(3)),
          message: cp.message[level] || cp.message.warn, timing: 'live',
        });
      }
      return sortAlerts(alerts);
    }

    _evaluateRepChecks(rep, t) {
      const alerts = [];
      for (const rc of (this.def.repChecks || [])) {
        const v = rep[rc.field];
        if (v == null) continue;
        let level = null;
        if (rc.danger && compare(v, rc.danger)) level = 'danger';
        else if (rc.warn && compare(v, rc.warn)) level = 'warn';
        if (!level) continue;
        const key = 'rep:' + rc.id;
        const last = this._lastFired[key];
        if (last != null && t - last < (rc.cooldownMs || 4000)) continue;
        this._lastFired[key] = t;
        alerts.push({
          id: rc.id, level, metric: rc.field, value: v,
          message: rc.message[level] || rc.message.warn, timing: 'endOfRep',
        });
      }
      return sortAlerts(alerts);
    }
  }

  function sortAlerts(a) {
    return a.sort((x, y) => (x.level === 'danger' ? 0 : 1) - (y.level === 'danger' ? 0 : 1));
  }

  const api = {
    FormEngine, EXERCISES, PHASE, LM,
    listExercises() {
      return Object.keys(EXERCISES).map(k => ({
        id: k,
        label: EXERCISES[k].label,
        recommendedView: EXERCISES[k].recommendedView,
        supportedViews: EXERCISES[k].supportedViews,
        viewHint: EXERCISES[k].viewHint || null,
        safetyNote: EXERCISES[k].safetyNote || null,
      }));
    },
  };

  global.FormEngine = FormEngine;
  global.FormEngineKit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
