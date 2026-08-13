/* =========================================================================
 * form-guard.js  —  撮影条件の検査（フェイルセーフ層）
 * -------------------------------------------------------------------------
 *  Phase 5: 実映像で必ず起きる問題を、フォーム指摘より前に潰す
 *
 *  依存なし。MediaPipe Pose の landmarks を毎フレーム渡す。
 *
 *      const guard = new SetupGuard({ view: 'front' });
 *      guard.setAspect(video.videoWidth, video.videoHeight);
 *      const g = guard.check(landmarks, performance.now());
 *      if (g.identitySwitch) engine.reset();      // 別人に乗り移った
 *      if (g.blocking) { showBanner(g.blocking.message); return; }  // 解析しない
 *
 *  設計方針:
 *   - 撮影条件の問題を「フォームの問題」として指摘してはいけない。
 *     足元が切れているのに「浅い」と言うのは、誤りであるだけでなく有害。
 *   - 判定はヒステリシス付き。1フレームのブレでバナーを点滅させない。
 *   - 検知できないものは検知できないと言う。斜め45度は正面でも側面でもなく、
 *     どちらのルールも精度が落ちるので、曖昧なら曖昧と報告する。
 * ========================================================================= */

(function (global) {
  'use strict';

  const I = { NOSE: 0, LS: 11, RS: 12, LE: 13, RE: 14, LH: 23, RH: 24,
              LK: 25, RK: 26, LA: 27, RA: 28 };

  /* 深刻度: block = 解析を止める / warn = 続けるが精度は落ちる */
  const ISSUES = {
    no_person:      { sev: 'block', msg: '人が映っていません。カメラの前に立ってください。' },
    partial_legs:   { sev: 'block', msg: '足元が切れています。カメラを下げるか、離れてください。' },
    partial_head:   { sev: 'block', msg: '頭が切れています。カメラを上に向けてください。' },
    partial_side:   { sev: 'block', msg: '体が画面からはみ出しています。中央に立ってください。' },
    too_close:      { sev: 'block', msg: '近すぎます。2〜3歩下がってください。' },
    too_far:        { sev: 'warn',  msg: '遠すぎます。1〜2歩近づくと精度が上がります。' },
    view_front_req: { sev: 'block', msg: '正面から撮る設定です。カメラに正対してください。' },
    view_side_req:  { sev: 'block', msg: '横から撮る設定です。カメラに対して真横を向いてください。' },
    view_diagonal:  { sev: 'warn',  msg: '斜めを向いています。真正面か真横に寄せると精度が上がります。' },
    unstable:       { sev: 'warn',  msg: '追跡が不安定です。明るい場所で、背景を整理してください。' },
  };

  function pt(lms, i) {
    const p = lms[i];
    return p ? { x: p.x, y: p.y, v: p.visibility != null ? p.visibility : 1 } : null;
  }
  const mid = (a, b) => (a && b) ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: (a.v + b.v) / 2 } : null;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  class SetupGuard {
    constructor(o) {
      o = o || {};
      this.view = o.view || 'front';
      this.aspect = 1;
      this.minVisibility = o.minVisibility != null ? o.minVisibility : 0.5;
      this.holdFrames = o.holdFrames != null ? o.holdFrames : 8;    // 問題ありと確定するまで
      this.clearFrames = o.clearFrames != null ? o.clearFrames : 14; // 解消と確定するまで
      this.margin = o.margin != null ? o.margin : 0.02;              // 画面端の許容
      this.torsoMin = o.torsoMin != null ? o.torsoMin : 0.10;
      this.torsoMax = o.torsoMax != null ? o.torsoMax : 0.42;
      this.jumpThreshold = o.jumpThreshold != null ? o.jumpThreshold : 0.18;
      // 本当の動作は滑らかで jerk が小さい。追跡ノイズだけが跳ね上がる。
      this.jerkThreshold = o.jerkThreshold != null ? o.jerkThreshold : 0.40;
      this.reset();
    }

    reset() {
      this._st = {};        // code -> { on, off, active }
      this._prev = null;    // 直前フレーム { t, hip, torso }
      this._jerk = 0;       // 加速度の移動平均（ジッタ検出）
      this._lastVel = null;
    }

    setAspect(w, h) { this.aspect = (w && h) ? w / h : 1; }
    setView(v) { this.view = v; this._st = {}; }

    /** @returns {{ok, blocking, issues, detected, identitySwitch}} */
    check(lms, timestamp) {
      const t = timestamp != null ? timestamp : Date.now();
      const A = this.aspect;
      const raw = {};
      for (const k in I) raw[k] = pt(lms || [], I[k]);
      const P = (k) => raw[k] ? { x: raw[k].x * A, y: raw[k].y, v: raw[k].v } : null;

      const found = new Set();
      let identitySwitch = false;
      let detected = { view: null, torso: null, widthRatio: null };

      const ls = P('LS'), rs = P('RS'), lh = P('LH'), rh = P('RH');
      const coreVis = Math.min(
        Math.max(ls ? ls.v : 0, rs ? rs.v : 0),
        Math.max(lh ? lh.v : 0, rh ? rh.v : 0)
      );

      if (!lms || lms.length < 33 || coreVis < this.minVisibility) {
        found.add('no_person');
        this._prev = null;
      } else {
        const shoulderMid = mid(ls, rs), hipMid = mid(lh, rh);
        const torso = dist(shoulderMid, hipMid);
        detected.torso = torso;

        /* --- 見切れ --- */
        const m = this.margin;
        const inFrame = (p) => p && raw && p.y > m && p.y < 1 - m;
        const nose = raw.NOSE, la = raw.LA, ra = raw.RA;
        if (nose && nose.v > this.minVisibility && nose.y < m) found.add('partial_head');
        const ankleSeen = (la && la.v > this.minVisibility) || (ra && ra.v > this.minVisibility);
        if (!ankleSeen || (la && la.y > 1 - m) || (ra && ra.y > 1 - m)) found.add('partial_legs');
        for (const k of ['LS', 'RS', 'LH', 'RH']) {
          const p = raw[k];
          if (p && p.v > this.minVisibility && (p.x < m || p.x > 1 - m)) { found.add('partial_side'); break; }
        }

        /* --- 距離 --- */
        if (torso > this.torsoMax) found.add('too_close');
        else if (torso < this.torsoMin) found.add('too_far');

        /* --- 向き ---
           肩幅・腰幅を体幹長で正規化すると、カメラに対する回転が読める。
           正対＝幅が広い / 真横＝幅がほぼ潰れる。中間は45度で、どちらのルールも当たらない。 */
        const sw = (ls && rs) ? Math.abs(ls.x - rs.x) : 0;
        const hw = (lh && rh) ? Math.abs(lh.x - rh.x) : 0;
        const wr = torso > 0.02 ? Math.max(sw, hw) / torso : null;
        detected.widthRatio = wr;
        if (wr != null) {
          detected.view = wr > 0.58 ? 'front' : (wr < 0.30 ? 'side' : null);
          if (detected.view === null) found.add('view_diagonal');
          else if (detected.view !== this.view) {
            found.add(this.view === 'front' ? 'view_front_req' : 'view_side_req');
          }
        }

        /* --- 別人への乗り移り ---
           MediaPipe Poseは1人しか追わないが、複数人が映ると突然乗り移る。
           腰の位置が瞬間移動したか、体格が急変したら別人とみなす。 */
        if (this._prev && t - this._prev.t < 400) {
          const jump = dist(hipMid, this._prev.hip);
          const scale = Math.abs(torso - this._prev.torso) / Math.max(this._prev.torso, 1e-3);
          if (jump > this.jumpThreshold || scale > 0.35) identitySwitch = true;

          /* --- ジッタ（加速度の移動平均） ---
             本当の動作は滑らか。細かく震えるのは追跡ノイズ。 */
          const dt = Math.max(t - this._prev.t, 1);
          const vel = { x: (hipMid.x - this._prev.hip.x) / dt, y: (hipMid.y - this._prev.hip.y) / dt };
          if (this._lastVel) {
            const jerk = Math.hypot(vel.x - this._lastVel.x, vel.y - this._lastVel.y) * 1000;
            this._jerk = this._jerk * 0.9 + jerk * 0.1;
            if (this._jerk > this.jerkThreshold) found.add('unstable');
          }
          this._lastVel = vel;
        } else {
          this._lastVel = null; this._jerk = 0;
        }
        this._prev = { t, hip: hipMid, torso };
      }

      if (identitySwitch) { this._jerk = 0; this._lastVel = null; }

      /* --- ヒステリシス ---
         並び順は「原因 → 症状」。近すぎれば手足も切れるが、
         言うべきは「下がってください」であって「足が切れています」ではない。 */
      const issues = [];
      const codes = ['no_person', 'too_close', 'partial_legs', 'partial_head', 'partial_side',
                     'view_front_req', 'view_side_req', 'too_far', 'view_diagonal', 'unstable'];
      for (const code of codes) {
        const st = this._st[code] || (this._st[code] = { on: 0, off: 0, active: false });
        if (found.has(code)) { st.on++; st.off = 0; if (st.on >= this.holdFrames) st.active = true; }
        else { st.off++; st.on = 0; if (st.off >= this.clearFrames) st.active = false; }
        if (st.active) issues.push({ code, severity: ISSUES[code].sev, message: ISSUES[code].msg });
      }
      // no_person が出ているときは他を隠す（原因は1つ）
      const np = issues.find(x => x.code === 'no_person');
      const list = np ? [np] : issues;
      const blocking = list.find(x => x.severity === 'block') || null;

      return { ok: !blocking, blocking, issues: list, detected, identitySwitch };
    }

    /** 撮影条件が continuous に問題なしなら true（開始ボタンの解放判定に使う） */
    isClean() {
      for (const c in this._st) if (this._st[c].active && ISSUES[c].sev === 'block') return false;
      return this._prev != null;
    }
  }

  const api = { SetupGuard, ISSUES };
  global.SetupGuard = SetupGuard;
  global.FormGuardKit = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

})(typeof globalThis !== 'undefined' ? globalThis : this);
