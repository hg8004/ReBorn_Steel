/* 기록 분석과 변인 영향 분석 (AI 배합 설계의 도구가 쓰는 계산)
   - history(): 과거 조업 이력 500 heat, 시세·재고 60일, 검수 메모를 주제별로 요약한다.
   - sensitivity(): 지금 배합에서 변인 하나(단가, Cu 함량, 재고, 규격, 목표 이탈 확률)만 바꿔 다시 풀고, 원가·배합·이탈 확률이 얼마나 변하는지 잰다.
   - binding(): 이 배합을 묶고 있는 제약(재고 한도, Cu·Sn 상한)을 찾는다. '왜 이렇게 섞었나'를 설명하는 핵심 근거다.
   회사가 가진 기록(CSV에서 내보낸 company.js)만 쓴다. 숨은 정답(ground_truth)은 읽지 않는다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RebornAnalysis = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function r(v, d) { var k = Math.pow(10, d); return Math.round(v * k) / k; }
  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : 0; }
  function sd(a) { var m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1)) : 0; }
  function pct(a, p) { var s = a.slice().sort(function (x, y) { return x - y; }); if (!s.length) return 0; var i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); }

  /* ---------- 과거 조업 이력 읽기 ---------- */
  function heatRows(C) {
    var H = C.heats, col = {}, G = C.config.grades;
    H.cols.forEach(function (c, i) { col[c] = i; });
    return H.rows.map(function (row) {
      return { id: row[col.heat_id], date: row[col.date], steel: row[col.steel],
               x: G.map(function (g) { return row[col["charge_" + g]]; }),
               tap: row[col.tap_t], cu: row[col.cu_pct], sn: row[col.sn_pct], kwh: row[col.power_kwh], pass: row[col.pass] };
    });
  }
  function marketDates(C, refDate) {
    return Object.keys(C.market).sort().filter(function (d) { return !refDate || d <= refDate; });
  }
  // 작은 선형 연립방정식 (가우스 소거, 정규방정식용)
  function solve(A, b) {
    var n = b.length, M = A.map(function (row, i) { return row.slice().concat([b[i]]); });
    for (var c = 0; c < n; c++) {
      var p = c; for (var i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
      var t = M[c]; M[c] = M[p]; M[p] = t;
      for (var j = c + 1; j < n; j++) { var f = M[j][c] / M[c][c]; for (var k = c; k <= n; k++) M[j][k] -= f * M[c][k]; }
    }
    var x = new Array(n);
    for (var q = n - 1; q >= 0; q--) { var s = M[q][n]; for (var z = q + 1; z < n; z++) s -= M[q][z] * x[z]; x[q] = s / M[q][q]; }
    return x;
  }

  /* ====================================================================
     기록 분석: 주제별 요약
     spec: 화면의 조건 {grades:[{id,name,price,inv,y,cu,...}], steels, notes, target}
     ==================================================================== */
  var TOPICS = ["grade_contribution", "spec_margin", "price_trend", "inventory", "notes_history", "power"];

  function history(C, spec, refDate, topic, opt) {
    var G = C.config.grades, est = C.estimate.grades, names = {}, inSpec = {};
    C.scrap.forEach(function (s) { names[s.grade_id] = s.name_kr; });
    spec.grades.forEach(function (g) { names[g.id] = g.name; inSpec[g.id] = g; });
    var rows = heatRows(C), period = C.history_period;
    var known = G.filter(function (g) { return inSpec[g]; });
    var unknown = spec.grades.filter(function (g) { return G.indexOf(g.id) < 0; }).map(function (g) { return g.name; });
    var base = { topic: topic, source: "과거 조업 이력 " + rows.length + " heat (" + period[0] + "~" + period[1] + ")" };
    if (unknown.length) base.no_history_grades = unknown;

    if (topic === "grade_contribution") {
      // 등급별 성분 추정값(이력 회귀)과, 과거 배합에서 Cu가 어느 등급에서 왔는지
      var fr = G.map(function () { return []; }), sh = G.map(function () { return []; }), pred = [], act = [];
      rows.forEach(function (h) {
        var tot = h.x.reduce(function (a, v) { return a + v; }, 0), cuSum = 0;
        h.x.forEach(function (v, i) { cuSum += v * est[G[i]].cu_mean; sh[i].push(v / tot * 100); });
        h.x.forEach(function (v, i) { fr[i].push(v * est[G[i]].cu_mean / cuSum * 100); });
        pred.push(cuSum / h.tap); act.push(h.cu);
      });
      var ma = mean(act), ssr = 0, sst = 0;
      act.forEach(function (a, i) { ssr += (a - pred[i]) * (a - pred[i]); sst += (a - ma) * (a - ma); });
      return Object.assign(base, {
        method: "출강 Cu·Sn = Σ(등급 성분 × 장입량) / 출강량 을 비음수 최소제곱으로 풀어 등급별 성분을 역추정",
        fit: { r2_cu: r(1 - ssr / sst, 3), rmse_cu_pct: r(Math.sqrt(ssr / act.length), 4), outlier_dates: C.estimate.outlier_dates },
        grades: G.map(function (g, i) {
          var e = est[g], o = { grade_id: g, name: names[g], nominal_cu_pct: e.nominal_cu, est_cu_pct: r(e.cu_mean, 4), est_cu_sd: r(e.cu_sd, 4), est_cu_se: r(e.cu_se, 4),
            nominal_sn_pct: e.nominal_sn, est_sn_pct: r(e.sn_mean, 5),
            est_vs_nominal_cu_pct: r((e.cu_mean - e.nominal_cu) / e.nominal_cu * 100, 1),
            hist_share_pct: { mean: r(mean(sh[i]), 1), min: r(Math.min.apply(null, sh[i]), 1), max: r(Math.max.apply(null, sh[i]), 1) },
            share_of_total_cu_pct: r(mean(fr[i]), 1) };
          if (inSpec[g]) o.input_cu_pct = inSpec[g].cu; else o.not_in_today_conditions = true;
          return o;
        })
      });
    }

    if (topic === "spec_margin") {
      // 강종별 과거 출강 성분이 상한에 얼마나 가까웠나 + 과거 평균 배합을 오늘 단가로 사면 얼마인가
      var out = {};
      spec.steels.filter(function (t) { return t.heats > 0; }).forEach(function (t) {
        var hs = rows.filter(function (h) { return h.steel === t.steel; }), basis = t.steel;
        if (!hs.length) { hs = rows; basis = "이 강종 이력이 없어 전체 이력으로 비교"; }
        var cu = hs.map(function (h) { return h.cu; }), sn = hs.map(function (h) { return h.sn; });
        var o = { basis: basis, heats: hs.length, pass_rate_pct: r(hs.filter(function (h) { return h.pass; }).length / hs.length * 100, 1),
          cu: { limit: t.cu, mean: r(mean(cu), 4), p95: r(pct(cu, 0.95), 4), max: r(Math.max.apply(null, cu), 4), headroom_p95: r(t.cu - pct(cu, 0.95), 4) },
          sn: { limit: t.sn, mean: r(mean(sn), 5), p95: r(pct(sn, 0.95), 5), max: r(Math.max.apply(null, sn), 5), headroom_p95: r(t.sn - pct(sn, 0.95), 5) } };
        if (known.length === G.length) {           // 등급 구성이 그대로면 과거 평균 배합의 오늘 원가
          var avg = G.map(function (g, i) { return mean(hs.map(function (h) { return h.x[i]; })); });
          var cost = 0, tap = 0;
          G.forEach(function (g, i) { cost += avg[i] * inSpec[g].price; tap += avg[i] * inSpec[g].y; });
          o.past_avg_blend_cost_today_krw_per_t = Math.round(cost / tap);
          if (opt && opt.byCost && opt.byCost[t.steel]) o.today_optimized_krw_per_t = Math.round(opt.byCost[t.steel]);
        }
        out[t.steel] = o;
      });
      return Object.assign(base, { note: "headroom_p95 = 상한 − 과거 95백분위. 클수록 과거 배합이 보수적이었다는 뜻.", steels: out });
    }

    if (topic === "price_trend") {
      var ds = marketDates(C, refDate), win = ds.slice(-30), today = win[win.length - 1], wk = win[Math.max(0, win.length - 8)];
      var gl = spec.grades.map(function (g) {
        var o = { grade_id: g.id, name: g.name, input_price: g.price, input_cu_pct: g.cu };
        if (C.market[today] && C.market[today][g.id]) {
          var ps = win.map(function (d) { return C.market[d][g.id][0]; }), m = mean(ps);
          o.market_today = C.market[today][g.id][0];
          o.chg_7d_pct = r((o.market_today - C.market[wk][g.id][0]) / C.market[wk][g.id][0] * 100, 2);
          o.mean_30d = Math.round(m); o.min_30d = Math.min.apply(null, ps); o.max_30d = Math.max.apply(null, ps);
          o.volatility_cv_pct = r(sd(ps) / m * 100, 2);
          o.input_vs_30d_mean_pct = r((g.price - m) / m * 100, 2);
        } else o.market = "시세 기록 없음";
        return o;
      });
      // 등급 간: Cu가 0.1%p 높으면 단가가 평균 얼마나 싼가 (오늘 입력값 기준 회귀)
      var xs = spec.grades.map(function (g) { return g.cu; }), ys = spec.grades.map(function (g) { return g.price; });
      var mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
      xs.forEach(function (x, i) { sxy += (x - mx) * (ys[i] - my); sxx += (x - mx) * (x - mx); });
      return Object.assign(base, { source: "시세·재고 기록 " + win[0] + "~" + today + " (" + win.length + "일)",
        grades: gl, price_per_cu: { krw_per_t_per_0_1pp_cu: sxx ? Math.round(sxy / sxx * 0.1) : null,
          note: "음수면 Cu가 많을수록 싸다는 뜻. 싼 스크랩을 쓸수록 Cu 상한에 가까워진다." } });
    }

    if (topic === "inventory") {
      var ds2 = marketDates(C, refDate).slice(-30), days = {};
      rows.forEach(function (h) { days[h.date] = 1; });
      var nDays = Object.keys(days).length;
      return Object.assign(base, { source: "재고 기록 " + ds2[0] + "~" + ds2[ds2.length - 1] + ", 과거 사용량은 조업 이력 " + nDays + "일",
        grades: spec.grades.map(function (g) {
          var i = G.indexOf(g.id), o = { grade_id: g.id, name: g.name, input_inventory_t: g.inv };
          if (i >= 0) {
            var avgInv = mean(ds2.map(function (d) { return C.market[d][g.id][1]; }));
            var use = rows.reduce(function (a, h) { return a + h.x[i]; }, 0) / nDays;
            o.avg_inventory_30d_t = Math.round(avgInv); o.past_daily_use_t = r(use, 1);
            o.cover_days = use ? r(g.inv / use, 1) : null;
            o.status = g.inv < 0.5 * avgInv || (use && g.inv < use) ? "부족" : g.inv > 1.5 * avgInv ? "과다" : "보통";
          } else o.status = "기록 없음";
          if (opt && opt.usage && opt.usage[g.id] != null) { o.today_use_t = r(opt.usage[g.id], 1); o.today_at_limit = opt.usage[g.id] >= g.inv * 0.995 - 0.05; }
          return o;
        }) });
    }

    if (topic === "notes_history") {
      var out2 = {}, words = C.config.cu_words.concat(C.config.sn_words), fix = /제거|완료|정상|이상\s*없|해결|선별 후/;
      var past = C.notes.filter(function (n) { return !refDate || n.date < refDate; });
      spec.grades.forEach(function (g) {
        var ns = past.filter(function (n) { return n.grade_id === g.id; });
        out2[g.id] = { name: g.name, notes: ns.length, recent: ns.slice(-3).map(function (n) { return n.date + " " + n.note_text; }) };
      });
      var od = C.estimate.outlier_dates || [];
      var onOut = past.filter(function (n) { return od.indexOf(n.date) >= 0; }).map(function (n) { return { date: n.date, grade: names[n.grade_id] || n.grade_id, text: n.note_text }; });
      var kw = past.filter(function (n) { return words.some(function (w) { return n.note_text.toLowerCase().indexOf(w) >= 0; }); });
      return Object.assign(base, { source: "검수 메모 " + past.length + "건 (" + (refDate ? refDate + " 이전" : "전체") + ")",
        by_grade: out2,
        outlier_dates: od, notes_on_outlier_dates: onOut,
        keyword_notes: { count: kw.length, with_resolution_words: kw.filter(function (n) { return fix.test(n.note_text); }).map(function (n) { return n.date + " " + (names[n.grade_id] || n.grade_id) + ": " + n.note_text; }),
          on_outlier_dates: kw.filter(function (n) { return od.indexOf(n.date) >= 0; }).length },
        note: "outlier_dates는 과거 성분 회귀에서 잔차가 유난히 컸던 날(이상 로트 의심). 이력 기간 밖의 메모는 대조할 수 없다." });
    }

    if (topic === "power") {
      // 전력 = Σ(등급별 톤당 전력 × 장입량) 으로 최소제곱 → 등급별 톤당 kWh
      var n = G.length, A = [], b = [];
      for (var i = 0; i < n; i++) { A.push(new Array(n).fill(0)); b.push(0); }
      rows.forEach(function (h) { for (var p = 0; p < n; p++) { b[p] += h.x[p] * h.kwh; for (var q = 0; q < n; q++) A[p][q] += h.x[p] * h.x[q]; } });
      for (var k = 0; k < n; k++) A[k][k] += 1e-6;
      var coef = solve(A, b), perTap = rows.map(function (h) { return h.kwh / h.tap; });
      return Object.assign(base, { method: "전력량 = Σ(등급별 톤당 전력 × 장입량)을 최소제곱으로 추정",
        avg_kwh_per_t_tap: Math.round(mean(perTap)),
        grades: G.map(function (g, i) { return { grade_id: g, name: names[g], kwh_per_t_charged: Math.round(coef[i]) }; }),
        note: "전력비는 오늘 배합 원가 계산(스크랩 구매비)에는 들어가지 않는다. 참고용." });
    }
    return { error: "모르는 주제: " + topic + ". 다음 중 하나: " + TOPICS.join(", ") };
  }

  /* ====================================================================
     배합을 묶고 있는 제약 찾기
     ==================================================================== */
  function binding(ctx, opt, margins) {
    var usage = {}, atLimit = [];
    ctx.grades.forEach(function (g, i) {
      var u = opt.x.reduce(function (a, xh) { return a + xh[i]; }, 0);
      usage[g] = u;
      if (ctx.inv[i] > 0 && u >= ctx.inv[i] * 0.995 - 0.05) atLimit.push(g);
    });
    var steel = {};
    Object.keys(ctx.specs).forEach(function (s) {
      var hs = opt.heats.filter(function (h) { return h.steel === s; }); if (!hs.length) return;
      var lim = ctx.specs[s], m = margins[s];
      var cuB = hs.filter(function (h) { return h.predCu >= (lim.cu - m.cu) - 1e-4; }).length;
      var snB = hs.filter(function (h) { return h.predSn >= (lim.sn - m.sn) - 1e-5; }).length;
      steel[s] = { heats: hs.length, cu_bound_heats: cuB, sn_bound_heats: snB,
                   limiting: cuB && snB ? "Cu·Sn" : cuB ? "Cu" : snB ? "Sn" : "없음" };
    });
    return { usage: usage, inventoryLimited: atLimit, steel: steel };
  }

  /* ====================================================================
     변인 영향 분석 (민감도)
     base: {opt, margins, nc}  ·  E: 엔진  ·  lp: solver
     factor: price | cu_mean | inventory | spec_cu | target_fail
     change: price·cu_mean·inventory·spec_cu는 % 변화, target_fail은 새 목표(%)
     ==================================================================== */
  var FACTORS = ["price", "cu_mean", "inventory", "spec_cu", "target_fail"];

  function cloneCtx(ctx) {
    var c = Object.assign({}, ctx); c.price = ctx.price.slice(); c.inv = ctx.inv.slice();
    c.specs = {}; Object.keys(ctx.specs).forEach(function (s) { c.specs[s] = { cu: ctx.specs[s].cu, sn: ctx.specs[s].sn }; });
    return c;
  }
  function cloneComp(comp) {
    var c = { grades: {}, meas_sd: comp.meas_sd };
    Object.keys(comp.grades).forEach(function (g) { c.grades[g] = Object.assign({}, comp.grades[g]); });
    return c;
  }
  function usageOf(ctx, opt) { return ctx.grades.map(function (g, i) { return opt.x.reduce(function (a, xh) { return a + xh[i]; }, 0); }); }
  function shifts(ctx, a, b, nameOf) {
    var ua = usageOf(ctx, a), ub = usageOf(ctx, b);
    return ctx.grades.map(function (g, i) { return { g: g, d: ub[i] - ua[i] }; })
      .filter(function (s) { return Math.abs(s.d) >= 1; })
      .sort(function (x, y) { return Math.abs(y.d) - Math.abs(x.d); }).slice(0, 3)
      .map(function (s) { return nameOf(s.g) + " " + (s.d > 0 ? "+" : "") + Math.round(s.d) + "t"; });
  }
  function maxP(sim) { return r(Math.max.apply(null, sim.map(function (x) { return x.p_fail; })) * 100, 1); }

  function sensitivity(E, su, base, lp, factor, change, targets, o) {
    o = o || {};
    var ctx = su.ctx, comp = su.comp, nameOf = o.nameOf || function (g) { return g; }, nSim = o.nSim || 1000;
    var tapTot = base.opt.heats.reduce(function (a, h) { return a + h.tap; }, 0), baseCost = base.opt.costPerT;
    var res = { factor: factor, change: change, base_cost_per_t: Math.round(baseCost), rows: [] };
    if (FACTORS.indexOf(factor) < 0) return { error: "모르는 변인: " + factor + ". 다음 중 하나: " + FACTORS.join(", ") };

    if (factor === "target_fail") {
      var t = change / 100;
      if (!(t > 0 && t < 0.2)) return { error: "target_fail의 change는 새 목표 이탈 확률(%)이에요. 예: 1 또는 3" };
      var sc = E.solveCore(ctx, comp, o.cfg, { flags: base.flags || [], nc: base.nc, target: t, lp: lp });
      if (!sc.opt) { res.rows.push({ target: "목표 " + change + "%", feasible: false }); return res; }
      res.rows.push({ target: "목표 이탈 확률 " + change + "%", feasible: true, cost_per_t: Math.round(sc.opt.costPerT),
        delta_krw_per_t: Math.round(sc.opt.costPerT - baseCost), delta_krw_per_day: Math.round((sc.opt.costPerT - baseCost) * tapTot),
        iterations: sc.iterations, max_p_fail_pct: maxP(sc.sim), pass: sc.pass, shifts: shifts(ctx, base.opt, sc.opt, nameOf) });
      res.note = "안전여유를 정해진 규칙으로 다시 맞춘 결과다. 기준 원가는 지금 배합.";
      return res;
    }

    var isSteel = factor === "spec_cu";
    var all = isSteel ? Object.keys(ctx.specs) : ctx.grades;
    var list = targets && targets.length ? targets.filter(function (x) { return all.indexOf(x) >= 0; }) : all;
    if (!list.length) return { error: "대상이 없어요. " + (isSteel ? "강종 이름" : "등급 ID") + "을 넣거나 빈 배열로 전체를 보세요: " + all.join(", ") };
    list.forEach(function (t) {
      var c2 = ctx, m2 = comp, i = ctx.grades.indexOf(t), k = 1 + change / 100, row = { target: isSteel ? t : nameOf(t) };
      if (factor === "price") { c2 = cloneCtx(ctx); c2.price[i] *= k; }
      if (factor === "inventory") { c2 = cloneCtx(ctx); c2.inv[i] = Math.max(0, c2.inv[i] * k); }
      if (factor === "spec_cu") { c2 = cloneCtx(ctx); c2.specs[t].cu *= k; }
      if (factor === "cu_mean") { m2 = cloneComp(comp); m2.grades[t].cu_mean *= k; m2.grades[t].cu_sd *= k; }
      var op = E.optimize(c2, m2, base.margins, base.nc, lp);
      if (op.status !== "ok") { row.feasible = false; row.note = "이 조건에서는 배합이 불가능"; res.rows.push(row); return; }
      row.feasible = true; row.cost_per_t = Math.round(op.costPerT);
      row.delta_krw_per_t = Math.round(op.costPerT - baseCost);
      row.delta_krw_per_day = Math.round((op.costPerT - baseCost) * tapTot);
      row.shifts = shifts(ctx, base.opt, op, nameOf);
      if (factor === "price") {      // 배합을 안 바꾸고 그대로 샀다면
        var used = base.opt.x.reduce(function (a, xh) { return a + xh[i]; }, 0);
        row.delta_if_blend_fixed_krw_per_t = Math.round(used * ctx.price[i] * (k - 1) / tapTot);
      }
      if (factor === "cu_mean" || factor === "spec_cu") {   // 위험 쪽 변인은 이탈 확률도 본다
        row.max_p_fail_pct = maxP(E.simulate(c2, op.x, m2, base.nc.mult, nSim, 1));
        row.max_p_fail_if_blend_fixed_pct = maxP(E.simulate(c2, base.opt.x, m2, base.nc.mult, nSim, 1));
      }
      res.rows.push(row);
    });
    res.rows.sort(function (a, b) { return Math.abs(b.delta_krw_per_t || 0) - Math.abs(a.delta_krw_per_t || 0); });
    res.note = "안전여유와 메모 판정은 지금 배합 그대로 두고 그 변인만 바꿔 다시 최적화했다.";
    return res;
  }

  return { TOPICS: TOPICS, FACTORS: FACTORS, history: history, binding: binding, sensitivity: sensitivity, heatRows: heatRows };
});
