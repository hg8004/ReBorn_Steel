/* 리본스틸 배합 엔진 (브라우저용)
   파이썬 도구를 같은 수식으로 옮긴 것이다. 숫자는 모두 이 코드가 계산한다.
     src/pipeline.py              expert_blend, initial_margins, run_version("v3")
     src/tools/parse_inspection_notes.py  키워드 규칙, to_constraints
     src/tools/optimize_blend.py  원가 최소 배합 (선형계획법)
     src/tools/simulate_heat.py   몬테카를로 모의 조업, 안전여유 조정 제안
   - 성분 추정(도구 3)은 파이썬이 과거 이력으로 계산한 결과(company.js의 estimate)를 그대로 쓴다.
   - 선형계획법은 javascript-lp-solver(전역 solver)를 쓴다. 파이썬은 HiGHS를 쓰므로 소수점 아래는 조금 다를 수 있다.
   - 난수는 시드를 고정한다. 같은 조건으로 다시 실행하면 같은 결과가 나온다(파이썬 numpy 난수와는 다르다).
   브라우저(window.RebornEngine)와 node(require) 양쪽에서 쓸 수 있다. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RebornEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------- 수학 도구 ---------- */
  // 표준정규분포 역함수 (Acklam 근사, 상대오차 < 1.2e-9) = scipy norm.ppf
  function normInv(p) {
    var a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    var b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    var c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    var d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    var pl = 0.02425, q, r;
    if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    q = p - 0.5; r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  // 시드 고정 난수 (mulberry32) + 정규분포 (Box-Muller)
  function makeRng(seed) {
    var s = (seed >>> 0) || 1, spare = null;
    function uni() { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
    function normal() {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u1 = uni() || 1e-12, u2 = uni(), rr = Math.sqrt(-2 * Math.log(u1));
      spare = rr * Math.sin(2 * Math.PI * u2); return rr * Math.cos(2 * Math.PI * u2);
    }
    return { uni: uni, normal: normal };
  }
  function dot(a, b) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
  function round5(v) { return Math.round(v * 1e5) / 1e5; }

  /* ---------- 도구 1: 오늘의 조건 ---------- */
  // overrides: {price: {grade: 원/t}, inv: {grade: t}}  (가정해 보기용)
  function makeContext(C, date, overrides) {
    var G = C.config.grades, ov = overrides || {}, mk = C.market[date];
    if (!mk) throw new Error(date + "의 시세·재고 데이터가 없어요.");
    var byId = {}; C.scrap.forEach(function (s) { byId[s.grade_id] = s; });
    var specs = {}; C.specs.forEach(function (s) { specs[s.steel_grade] = { cu: s.cu_max_pct, sn: s.sn_max_pct }; });
    return {
      date: date, grades: G,
      plan: C.plan.map(function (p) { return { heat_id: p.heat_id, steel: p.steel_grade, W: p.target_tap_weight_t }; }),
      price: G.map(function (g) { return ov.price && ov.price[g] != null ? +ov.price[g] : mk[g][0]; }),
      inv: G.map(function (g) { return ov.inv && ov.inv[g] != null ? +ov.inv[g] : mk[g][1]; }),
      basePrice: G.map(function (g) { return mk[g][0]; }), baseInv: G.map(function (g) { return mk[g][1]; }),
      y: G.map(function (g) { return byId[g].yield; }),
      dens: G.map(function (g) { return byId[g].bulk_density_t_per_m3; }),
      name: G.map(function (g) { return byId[g].name_kr; }),
      specs: specs, vol: C.config.max_charge_volume_m3
    };
  }

  /* ---------- 도구 2: 검수 메모 (키워드 규칙) ---------- */
  function keywordJudge(notes, cfg) {
    return notes.map(function (n) {
      var t = String(n.note_text).toLowerCase(), elem = "none";
      if (cfg.cu_words.some(function (w) { return t.indexOf(w) >= 0; })) elem = "cu";
      else if (cfg.sn_words.some(function (w) { return t.indexOf(w) >= 0; })) elem = "sn";
      return { lot_id: n.lot_id, grade_id: n.grade_id, element: elem, risk: elem !== "none" ? "high" : "none",
               suspected_multiplier: elem !== "none" ? 2.0 : 1.0, reason: "키워드 규칙: '" + n.note_text + "'" };
    });
  }
  // 판정 → 배합 제약. risk high: 제외, medium: 장입 비율 5% 이하, 둘 다 성분을 배수만큼 높게 가정
  function toConstraints(flags) {
    var exclude = [], cap = {}, mult = {};
    flags.forEach(function (f) {
      if (f.risk === "high" && exclude.indexOf(f.grade_id) < 0) exclude.push(f.grade_id);
      else if (f.risk === "medium") cap[f.grade_id] = 0.05;
      if (f.risk !== "none" && (f.element === "cu" || f.element === "sn")) mult[f.grade_id + "|" + f.element] = f.suspected_multiplier;
    });
    return { exclude: exclude.sort(), cap: cap, mult: mult };
  }

  /* ---------- 성분 평균·편차 (배수 반영) ---------- */
  function params(comp, G, e, mult) {
    var mu = [], sd = [], se = [];
    G.forEach(function (g, j) {
      var k = comp.grades[g], m = (mult && mult[g + "|" + e]) || 1;
      mu[j] = k[e + "_mean"] * m; sd[j] = k[e + "_sd"] * m; se[j] = (k[e + "_se"] || 0) * m;
    });
    return { mu: mu, sd: sd, se: se };
  }

  /* ---------- 배합 정리 (지시서용 숫자) ---------- */
  function summarize(ctx, x, muCu, muSn) {
    var heats = ctx.plan.map(function (p, h) {
      var xh = x[h], tap = dot(xh, ctx.y), cost = dot(xh, ctx.price);
      return { heat_id: p.heat_id, steel: p.steel, W: p.W, x: xh, charge: xh.reduce(function (a, b) { return a + b; }, 0), tap: tap,
               vol: xh.reduce(function (a, v, i) { return a + v / ctx.dens[i]; }, 0),
               predCu: dot(xh, muCu) / tap, predSn: dot(xh, muSn) / tap,
               cuMax: ctx.specs[p.steel].cu, snMax: ctx.specs[p.steel].sn, cost: cost, costPerT: cost / tap };
    });
    var tc = heats.reduce(function (a, h) { return a + h.cost; }, 0), tt = heats.reduce(function (a, h) { return a + h.tap; }, 0);
    return { heats: heats, x: x, totalCost: tc, costPerT: tc / tt };
  }

  /* ---------- 숙련자 배합 (비교 기준) ---------- */
  function expertBlend(ctx, comp, cfg) {
    var G = ctx.grades, y = ctx.y, inv = ctx.inv.slice();
    var x = ctx.plan.map(function (p) {
      var r = cfg.expert_recipe[p.steel].map(function (v) { return v / 100; }), k = p.W / dot(r, y);
      return r.map(function (v) { return v * k; });
    });
    G.forEach(function (g, i) {
      var need = x.reduce(function (a, xh) { return a + xh[i]; }, 0);
      if (need <= inv[i]) return;
      var removed = x.map(function (xh) { return xh[i] * (1 - inv[i] / need); });
      x.forEach(function (xh, h) { xh[i] -= removed[h]; });
      for (var s = 0; s < cfg.substitutes.length; s++) {
        var j = G.indexOf(cfg.substitutes[s]);
        var room = inv[j] - x.reduce(function (a, xh) { return a + xh[j]; }, 0);
        if (cfg.substitutes[s] === g || room <= 0) continue;
        var add = removed.map(function (v) { return v * y[i] / y[j]; });
        var sum = add.reduce(function (a, b) { return a + b; }, 0), k = Math.min(1, room / sum);
        x.forEach(function (xh, h) { xh[j] += add[h] * k; });
        removed = removed.map(function (v) { return v * (1 - k); });
        if (removed.reduce(function (a, b) { return a + b; }, 0) < 1e-6) break;
      }
    });
    return summarize(ctx, x, params(comp, G, "cu").mu, params(comp, G, "sn").mu);
  }

  // 숙련자 배합표를 쓸 수 있는가: 등급 구성이 기본 8종과 같고, 모든 강종의 배합표가 있을 때만
  function canExpert(ctx, cfg) {
    if (!cfg || !cfg.expert_recipe || !cfg.grades || ctx.grades.length !== cfg.grades.length) return false;
    for (var i = 0; i < ctx.grades.length; i++) if (ctx.grades[i] !== cfg.grades[i]) return false;
    return Object.keys(ctx.specs).every(function (s) { return !!cfg.expert_recipe[s]; });
  }
  // 기준 배합: 모든 등급을 같은 무게 비율로 섞은 배합 (사용자 조건처럼 숙련자 배합표가 없을 때 첫 안전여유 계산용)
  function equalBlend(ctx, comp) {
    var n = ctx.grades.length, r = ctx.grades.map(function () { return 1 / n; });
    var x = ctx.plan.map(function (p) { var k = p.W / dot(r, ctx.y); return r.map(function (v) { return v * k; }); });
    return summarize(ctx, x, params(comp, ctx.grades, "cu").mu, params(comp, ctx.grades, "sn").mu);
  }

  /* ---------- 첫 안전여유 = z × (기준 배합의 heat 성분 표준편차) ----------
     기준 배합은 숙련자 배합표(쓸 수 있을 때) 또는 등급별 같은 비율 배합 */
  function initialMargins(ctx, comp, cfg, target) {
    var z = normInv(1 - target / 2), eb = canExpert(ctx, cfg) ? expertBlend(ctx, comp, cfg) : equalBlend(ctx, comp), G = ctx.grades, out = {};
    Object.keys(ctx.specs).forEach(function (s) {
      var rows = []; ctx.plan.forEach(function (p, h) { if (p.steel === s) rows.push(h); });
      var m = {};
      ["cu", "sn"].forEach(function (e) {
        var pr = params(comp, G, e), sig = 0;
        rows.forEach(function (h) {
          var xh = eb.x[h], a = 0;
          for (var i = 0; i < G.length; i++) a += Math.pow(xh[i] * pr.sd[i], 2) + Math.pow(xh[i] * pr.se[i], 2);
          sig = Math.max(sig, Math.sqrt(a) / dot(xh, ctx.y));
        });
        m[e] = rows.length ? round5(z * Math.sqrt(sig * sig + Math.pow(comp.meas_sd[e], 2))) : 0;
      });
      out[s] = m;
    });
    return out;
  }

  /* ---------- 도구 4: 원가 최소 배합 (선형계획법, 하루 24 heat 동시) ---------- */
  function optimize(ctx, comp, margins, nc, lp) {
    var G = ctx.grades, H = ctx.plan.length;
    nc = nc || { exclude: [], cap: {}, mult: {} };
    var muCu = params(comp, G, "cu", nc.mult).mu, muSn = params(comp, G, "sn", nc.mult).mu;
    var model = { optimize: "cost", opType: "min", constraints: {}, variables: {} };
    ctx.plan.forEach(function (p, h) {
      var lim = ctx.specs[p.steel], m = margins[p.steel];
      model.constraints["tap" + h] = { equal: p.W };                                 // 출강량
      model.constraints["cu" + h] = { max: (lim.cu - m.cu) * p.W };                  // Cu ≤ (상한 − 여유) × W
      model.constraints["sn" + h] = { max: (lim.sn - m.sn) * p.W };
      model.constraints["vol" + h] = { max: ctx.vol };                               // 버킷 용적
      Object.keys(nc.cap).forEach(function (g) { model.constraints["cap" + h + "_" + g] = { max: 0 }; });
    });
    G.forEach(function (g, i) { model.constraints["inv" + i] = { max: ctx.inv[i] }; }); // 하루 재고
    for (var h = 0; h < H; h++) {
      for (var i = 0; i < G.length; i++) {
        if (nc.exclude.indexOf(G[i]) >= 0) continue;                                 // 위험 로트 등급 제외
        var v = { cost: ctx.price[i] };
        v["tap" + h] = ctx.y[i]; v["cu" + h] = muCu[i]; v["sn" + h] = muSn[i]; v["vol" + h] = 1 / ctx.dens[i]; v["inv" + i] = 1;
        Object.keys(nc.cap).forEach(function (g) { v["cap" + h + "_" + g] = (G[i] === g ? 1 : 0) - nc.cap[g]; });
        model.variables["x" + h + "_" + i] = v;
      }
    }
    var res = lp.Solve(model);
    if (!res.feasible) return { status: "infeasible", message: "조건을 모두 만족하는 배합이 없어요. 재고나 안전여유를 확인해 보세요." };
    var x = ctx.plan.map(function (p, hh) {
      return G.map(function (g, ii) { var val = res["x" + hh + "_" + ii] || 0; return val < 1e-6 ? 0 : val; });
    });
    var out = summarize(ctx, x, muCu, muSn); out.status = "ok"; return out;
  }

  /* ---------- 도구 5: 몬테카를로 모의 조업 ---------- */
  function simulate(ctx, x, comp, mult, n, seed) {
    var rnd = makeRng(seed), G = ctx.grades, nG = G.length;
    var P = { cu: params(comp, G, "cu", mult), sn: params(comp, G, "sn", mult) };
    return ctx.plan.map(function (p, h) {
      var xh = x[h], tap0 = dot(xh, ctx.y), lim = ctx.specs[p.steel];
      var acc = { cu: [0, 0, 0], sn: [0, 0, 0] }, fail = 0;               // [합, 제곱합, 이탈 수]
      for (var k = 0; k < n; k++) {
        var tap = tap0 * (1 + 0.006 * rnd.normal()), bad = false;
        for (var e in P) {
          var pr = P[e], s = 0;
          for (var i = 0; i < nG; i++) {
            if (!xh[i]) { rnd.normal(); rnd.normal(); continue; }           // 난수 순서를 heat 배합과 무관하게 유지
            var c = pr.mu[i] + rnd.normal() * pr.se[i] + rnd.normal() * pr.sd[i];
            s += Math.max(c, 0.3 * pr.mu[i]) * xh[i];
          }
          var v = s / tap + rnd.normal() * comp.meas_sd[e], over = v > lim[e];
          acc[e][0] += v; acc[e][1] += v * v; if (over) { acc[e][2]++; bad = true; }
        }
        if (bad) fail++;
      }
      function sd(a) { var m = a[0] / n; return Math.sqrt(Math.max(a[1] / n - m * m, 0)); }
      return { heat_id: p.heat_id, steel: p.steel, p_fail: fail / n, p_fail_cu: acc.cu[2] / n, p_fail_sn: acc.sn[2] / n,
               cu_mean: acc.cu[0] / n, cu_sd: sd(acc.cu), sn_mean: acc.sn[0] / n, sn_sd: sd(acc.sn) };
    });
  }

  // 목표를 넘은 강종만, 상한까지 남은 거리가 z×σ보다 부족한 만큼(+3%) 안전여유를 키운다
  function suggestMargins(sim, ctx, margins, target) {
    var z = normInv(1 - target), next = {}, status = {};
    Object.keys(margins).forEach(function (s) {
      next[s] = { cu: margins[s].cu, sn: margins[s].sn };
      var rows = sim.filter(function (r) { return r.steel === s; });
      if (!rows.length) return;
      var worst = Math.max.apply(null, rows.map(function (r) { return r.p_fail; }));
      status[s] = { max_p_fail: worst, pass: worst <= target };
      if (worst <= target) return;
      ["cu", "sn"].forEach(function (e) {
        var limit = ctx.specs[s][e];
        var short = Math.max.apply(null, rows.map(function (r) { return z * r[e + "_sd"] - (limit - r[e + "_mean"]); }));
        var worstE = Math.max.apply(null, rows.map(function (r) { return r["p_fail_" + e]; }));
        if (worstE > target / 4) next[s][e] = round5(margins[s][e] + Math.max(short, 0) + 0.03 * margins[s][e] + 1e-4);
      });
    });
    return { next: next, status: status };
  }

  /* ---------- 에이전트 실행 (파이썬 run_version "v3"와 같은 순서) ----------
     opts: {flags: 검수 메모 판정(사람이 고친 것 포함), target: 목표 이탈확률, overrides: 가정 조건, lp: solver}
     반환: {ok, ctx, flags, nc, margins, opt, sim, iterations, steps:[화면에 보여줄 단계], expert} */
  function run(C, date, opts) {
    var cfg = C.config, comp = C.estimate, target = opts.target || cfg.target_fail_prob, lp = opts.lp;
    var steps = [], ctx = makeContext(C, date, opts.overrides);
    steps.push({ tool: "load_context", title: "오늘 조건 조회", detail: ctx.plan.length + " heat 계획, 스크랩 " + ctx.grades.length + "개 등급의 시세·재고" });
    var flags = opts.flags, nc = toConstraints(flags);
    steps.push({ tool: "parse_inspection_notes", title: "검수 메모 판정 반영",
      detail: "메모 " + flags.length + "건 → 제외 " + (nc.exclude.length ? nc.exclude.join(", ") : "없음") + ", 5% 제한 " + (Object.keys(nc.cap).join(", ") || "없음") });
    steps.push({ tool: "estimate_composition", title: "등급별 실제 성분 (과거 이력 회귀)",
      detail: "과거 " + comp.n_heats + " heat 이력으로 추정한 Cu·Sn 평균과 편차 사용" });
    return solveCore(ctx, comp, cfg, { flags: flags, nc: nc, target: target, lp: lp, steps: steps });
  }

  /* ---------- 반복 계산의 본체: 첫 안전여유 → [최적화 → 모의 조업 → 여유 조정] × 최대 N회 ----------
     o: {flags, nc, target, lp, steps(앞에 붙일 단계), margins(첫 안전여유, 없으면 자동)} */
  function solveCore(ctx, comp, cfg, o) {
    var target = o.target, lp = o.lp, nc = o.nc, flags = o.flags, steps = o.steps || [];
    var expert = canExpert(ctx, cfg) ? expertBlend(ctx, comp, cfg) : null;
    var margins = o.margins || initialMargins(ctx, comp, cfg, target), opt = null, sim = null, it = 0, used = margins, ok = false;
    for (it = 1; it <= cfg.max_iterations; it++) {
      var o = optimize(ctx, comp, margins, nc, lp);
      if (o.status !== "ok") {
        steps.push({ tool: "optimize_blend", iter: it, title: "원가 최소 배합 계산 실패", detail: o.message + " → 안전여유를 20% 줄여 다시 시도", bad: true });
        var shrunk = {}; Object.keys(margins).forEach(function (s) { shrunk[s] = { cu: margins[s].cu * 0.8, sn: margins[s].sn * 0.8 }; });
        margins = shrunk; continue;
      }
      opt = o; used = margins;
      steps.push({ tool: "optimize_blend", iter: it, title: "원가 최소 배합 계산 (" + it + "회차)", detail: "톤당 " + Math.round(o.costPerT).toLocaleString("ko-KR") + "원", margins: margins });
      sim = simulate(ctx, o.x, comp, nc.mult, cfg.n_sim, it);
      var sg = suggestMargins(sim, ctx, margins, target);
      var worst = {}; Object.keys(sg.status).forEach(function (s) { worst[s] = sg.status[s].max_p_fail; });
      ok = Object.keys(sg.status).every(function (s) { return sg.status[s].pass; });
      steps.push({ tool: "simulate_heat", iter: it, title: "모의 조업 " + cfg.n_sim.toLocaleString("ko-KR") + "회", worst: worst, pass: ok,
        detail: ok ? "모든 강종이 목표(" + (target * 100) + "%) 이하 → 통과" : "목표(" + (target * 100) + "%)를 넘는 강종이 있어 안전여유를 키워 다시 계산" });
      if (ok) break;
      margins = sg.next;
    }
    if (it > cfg.max_iterations) it = cfg.max_iterations;
    if (opt) steps.push({ tool: "write_charge_sheet", title: ok ? "배합 지시서 작성" : "최대 반복에 도달, 마지막 배합으로 지시서 작성", bad: !ok,
      detail: "톤당 " + Math.round(opt.costPerT).toLocaleString("ko-KR") + "원" + (expert ? " (숙련자 배합 " + Math.round(expert.costPerT).toLocaleString("ko-KR") + "원)" : "") });
    return { ok: !!opt, pass: ok, ctx: ctx, comp: comp, flags: flags, nc: nc, margins: used, opt: opt, sim: sim, iterations: it, steps: steps, expert: expert, target: target };
  }

  /* ---------- 사용자가 입력한 조건으로 계산 준비 ----------
     spec = { grades: [{id, name, price, inv, y, dens, cu, cuSd, sn, snSd}],
              steels: [{steel, cu, sn, heats, W}], vol, measSd: {cu, sn} }
     → {ctx, comp}: 고정 데이터 대신 입력값으로 만든 '오늘의 조건'과 성분 분포 */
  function customSetup(spec) {
    var G = spec.grades.map(function (g) { return g.id; }), specs = {}, plan = [], k = 1;
    spec.steels.forEach(function (s) {
      specs[s.steel] = { cu: +s.cu, sn: +s.sn };
      for (var i = 0; i < s.heats; i++) plan.push({ heat_id: "P" + (k < 10 ? "0" : "") + (k++), steel: s.steel, W: +s.W });
    });
    var num = function (key) { return spec.grades.map(function (g) { return +g[key]; }); };
    var ctx = { date: "custom", grades: G, plan: plan, price: num("price"), inv: num("inv"), basePrice: num("price"), baseInv: num("inv"),
                y: num("y"), dens: num("dens"), name: spec.grades.map(function (g) { return g.name; }), specs: specs, vol: +spec.vol };
    var comp = { grades: {}, meas_sd: spec.measSd || { cu: 0.005, sn: 0.0008 } };
    // cuSe·snSe: 평균 자체의 추정 오차(이력 회귀의 표준오차). 회사 추정값을 불러온 등급에만 있고, 직접 넣은 등급은 0
    spec.grades.forEach(function (g) { comp.grades[g.id] = { cu_mean: +g.cu, cu_sd: +g.cuSd, cu_se: +g.cuSe || 0, sn_mean: +g.sn, sn_sd: +g.snSd, sn_se: +g.snSe || 0 }; });
    return { ctx: ctx, comp: comp };
  }

  return { normInv: normInv, makeRng: makeRng, makeContext: makeContext, keywordJudge: keywordJudge, toConstraints: toConstraints,
           expertBlend: expertBlend, equalBlend: equalBlend, canExpert: canExpert, initialMargins: initialMargins, optimize: optimize, simulate: simulate,
           suggestMargins: suggestMargins, run: run, solveCore: solveCore, customSetup: customSetup };
});
