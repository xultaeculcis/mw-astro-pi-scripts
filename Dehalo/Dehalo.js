// ----------------------------------------------------------------------------
// Dehalo.js - model and reduce wide halos of bright stars on LINEAR images
// ----------------------------------------------------------------------------
//
// Method (per channel, on a binned copy of the image):
//   1. Detect bright stars by their saturated cores (or add them by hand).
//   2. For every star, measure the azimuthal sigma-clipped median profile in
//      log-spaced annuli. Other stars' models, a sky plane and an optional
//      exclusion mask (galaxy, tidal tails, IFN) are taken out first.
//   3. Fit the profile tail as  s + A*(r/1000)^-a ; s is local sky and goes to
//      the plane. The profile is smoothed; beyond the radius where it falls
//      into the noise it continues as a power law and tapers to zero.
//   4. Iterate stars + sky plane a few times (joint fit).
//   5. Subtract  w(r) * halo(r)  where w(r) goes from "inner reduction" near
//      the star to "outer reduction" on the outskirts. A natural, light halo
//      stays around the star; the faint wings over galaxies and IFN go away.
//
// The sky plane is only used for fitting; it is never subtracted.
// Subtraction is valid on linear data only. Run it per master before
// gradient removal, BlurXTerminator and stretching.
//
// Engine code between ENGINE-BEGIN and ENGINE-END has no PixInsight
// dependencies and is tested with node (test/engine_test.js).
// ----------------------------------------------------------------------------

#feature-id    Dehalo : Utilities > Dehalo
#feature-info  Models and reduces wide halos of bright stars on linear images. \
   Joint azimuthal profile fit of several stars with a sky plane and an \
   optional exclusion mask; radius-dependent reduction keeps a natural halo. \
   Copyright (C) 2026 Michal Wierzbinski

#include <pjsr/Sizer.jsh>
#include <pjsr/NumericControl.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/TextAlign.jsh>
#include <pjsr/UndoFlag.jsh>
#include <pjsr/FrameStyle.jsh>
#include <pjsr/ColorSpace.jsh>
#include <pjsr/SampleType.jsh>
#include <pjsr/ButtonCodes.jsh>
#include <pjsr/PenStyle.jsh>
#include <pjsr/StdCursor.jsh>
#include <pjsr/FocusStyle.jsh>
#include <pjsr/KeyCodes.jsh>

#define HR_TITLE   "Dehalo"
#define HR_VERSION "0.6"
#define HR_COPYRIGHT "&copy; 2026 Michal Wierzbinski"

// Folder of this script; the local documentation copy lives in doc/ next to it.
var HR_DIR = File.extractDrive(#__FILE__) + File.extractDirectory(#__FILE__);
var HR_DOC_LOCAL = HR_DIR + "/doc/scripts/" + HR_TITLE + "/" + HR_TITLE + ".html";

// ENGINE-BEGIN
var HR = {};

HR.MODE_EMPIRICAL = 0;
HR.MODE_POWERLAW = 1;

HR.defaults = function () {
   return {
      bin: 4,               // binning factor for fitting / preview
      satLevel: 0.95,       // saturation threshold (normalized)
      minCoreRadius: 6,     // px, smallest saturated core counted as a halo star
      maxStars: 8,
      innerFactor: 2.0,     // fit starts at innerFactor * core radius
      fitRadius: 5000,      // px, max halo radius of the brightest star (others scale by core radius)
      iterations: 3,
      mode: HR.MODE_EMPIRICAL,
      smoothing: 0.5,       // 0..1 profile smoothing
      // reduction
      outerAmount: 1.0,     // 0..1.5 fraction subtracted on the outskirts
      innerAmount: 0.3,     // 0..1 fraction subtracted near the star
      coreProtect: 0.0,     // x core radius: protected zone, full weight at twice this radius (0 = off)
      coreOpacity: 0.0,     // 0..1 how much of the zone is protected (0 = off, 1 = nothing subtracted inside)
      protectRadius: 600,   // px, radius (brightest star) where reduction starts to grow
      transition: 1500,     // px, width of the ramp inner -> outer
      scaleRadii: true      // scale protect/transition radii by core radius
   };
};

HR.smoothstep = function (t) {
   t = t < 0 ? 0 : (t > 1 ? 1 : t);
   return t * t * (3 - 2 * t);
};

HR.lowerBound = function (v, lo, hi, x) {
   while (lo < hi) { var m = (lo + hi) >> 1; if (v[m] < x) lo = m + 1; else hi = m; }
   return lo;
};

HR.upperBound = function (v, lo, hi, x) {
   while (lo < hi) { var m = (lo + hi) >> 1; if (v[m] <= x) lo = m + 1; else hi = m; }
   return lo;
};

HR.sortedMedian = function (v, lo, hi) {
   var n = hi - lo, mid = lo + (n >> 1);
   return (n & 1) ? v[mid] : 0.5 * (v[mid - 1] + v[mid]);
};

// PixInsight's engine has no TypedArray sort/fill/from; sort through a plain Array there.
HR.sortTyped = function (v) {
   if (v.sort) { v.sort(); return v; }
   var a = Array.prototype.slice.call(v);
   a.sort(function (x, y) { return x - y; });
   for (var i = 0; i < a.length; ++i) v[i] = a[i];
   return v;
};

HR.MAX_BIN_SAMPLES = 5000;

// Sigma-clipped median of a typed array (sorted in place). Clipping keeps a
// window [lo,hi) of the sorted values, so every iteration is two binary searches.
// Large bins are subsampled with a fixed stride (median precision is unaffected).
HR.clippedMedian = function (v) {
   if (v.length > HR.MAX_BIN_SAMPLES) {
      var sub = new Float32Array(HR.MAX_BIN_SAMPLES), step = v.length / HR.MAX_BIN_SAMPLES;
      for (var i = 0; i < HR.MAX_BIN_SAMPLES; ++i) sub[i] = v[Math.floor(i * step)];
      v = sub;
   }
   HR.sortTyped(v);
   var lo = 0, hi = v.length, med = NaN, sig = NaN;
   for (var it = 0; it < 6; ++it) {
      var n = hi - lo;
      if (n < 5) break;
      med = HR.sortedMedian(v, lo, hi);
      sig = 0.5 * (v[lo + Math.floor(0.8413 * (n - 1))] - v[lo + Math.floor(0.1587 * (n - 1))]);
      if (!(sig > 0)) break;
      var nlo = HR.lowerBound(v, lo, hi, med - 2.5 * sig);
      var nhi = HR.upperBound(v, lo, hi, med + 2.5 * sig);
      if (nlo == lo && nhi == hi) break;
      lo = nlo; hi = nhi;
   }
   if (hi - lo > 0) med = HR.sortedMedian(v, lo, hi);
   return { med: med, sigma: sig, n: hi - lo };
};

// Saturated connected components on the binned max image.
HR.detectStars = function (mx, w, h, B, opts) {
   var vis = new Uint8Array(w * h), stack = new Int32Array(w * h), stars = [];
   for (var p0 = 0; p0 < w * h; ++p0) {
      if (vis[p0] || mx[p0] < opts.satLevel) continue;
      var sp = 0, n = 0, sx = 0, sy = 0;
      stack[sp++] = p0; vis[p0] = 1;
      while (sp > 0) {
         var p = stack[--sp], x = p % w, y = (p - x) / w;
         ++n; sx += x; sy += y;
         var nb = [p - 1, p + 1, p - w, p + w], ok = [x > 0, x < w - 1, y > 0, y < h - 1];
         for (var k = 0; k < 4; ++k)
            if (ok[k] && !vis[nb[k]] && mx[nb[k]] >= opts.satLevel) { vis[nb[k]] = 1; stack[sp++] = nb[k]; }
      }
      var area = n * B * B, rc = Math.sqrt(area / Math.PI);
      if (rc >= opts.minCoreRadius)
         stars.push({ x: (sx / n + 0.5) * B, y: (sy / n + 0.5) * B, rcore: rc, enabled: true, manual: false });
   }
   stars.sort(function (a, b) { return b.rcore - a.rcore; });
   return stars.slice(0, opts.maxStars);
};

// Per-star geometry derived from options (brightest star = reference).
// The reference core radius is the largest detected one (for an edited star its detected
// value), so that adding or resizing a manual star does not change the other stars.
HR.starGeometry = function (stars, opts) {
   var ref = 0, all = 0;
   for (var i = 0; i < stars.length; ++i) {
      var t = stars[i];
      all = Math.max(all, t.rcore);
      ref = Math.max(ref, t.det ? t.det.rcore : t.manual ? 0 : t.rcore);
   }
   if (ref <= 0) ref = all;
   for (var i = 0; i < stars.length; ++i) {
      var s = stars[i], k = ref > 0 ? s.rcore / ref : 1;
      s.rIn = Math.max(opts.innerFactor * s.rcore, 2 * opts.bin, 8);
      s.rFit = Math.max(opts.fitRadius * k, 20 * s.rIn);
      s.radiusScale = opts.scaleRadii ? k : 1;
   }
};

HR.binEdges = function (rIn, rMax, B) {
   var e = [rIn];
   while (e[e.length - 1] < rMax) {
      var last = e[e.length - 1];
      e.push(Math.max(last * 1.035, last + B));
   }
   return e;
};

HR.planeAt = function (pl, x, y) { return pl.a + pl.b * x + pl.c * y; };

// Azimuthal profile of the residual  M - plane - T  around star k
// (the caller removes star k's own model from T first).
HR.measureProfile = function (ctx, k) {
   var s = ctx.stars[k], B = ctx.B, w = ctx.w, h = ctx.h;
   var edges = HR.binEdges(s.rIn, s.rFit, B), nb = edges.length - 1;
   var lnE0 = Math.log(edges[0]);
   var i0 = Math.max(0, Math.floor((s.x - s.rFit) / B)), i1 = Math.min(w - 1, Math.ceil((s.x + s.rFit) / B));
   var j0 = Math.max(0, Math.floor((s.y - s.rFit) / B)), j1 = Math.min(h - 1, Math.ceil((s.y + s.rFit) / B));
   var bw = Math.max(i1 - i0 + 1, 0), bh = Math.max(j1 - j0 + 1, 0);   // 0: star too far outside the image
   var binOf = new Int32Array(bw * bh), counts = new Int32Array(nb);
   // pass 1: bin index (binary search on edges, guess from log spacing first)
   for (var j = j0; j <= j1; ++j) {
      var dy = (j + 0.5) * B - s.y;
      for (var i = i0; i <= i1; ++i) {
         var q = (j - j0) * bw + (i - i0), p = j * w + i;
         binOf[q] = -1;
         if (ctx.excl[p]) continue;
         var dx = (i + 0.5) * B - s.x, r = Math.sqrt(dx * dx + dy * dy);
         if (r < edges[0] || r >= edges[nb]) continue;
         var b = HR.upperBound(edges, 0, nb + 1, r) - 1;
         if (b < 0 || b >= nb) continue;
         binOf[q] = b; counts[b]++;
      }
   }
   var offs = new Int32Array(nb + 1);
   for (var b = 0; b < nb; ++b) offs[b + 1] = offs[b] + counts[b];
   var vals = new Float32Array(offs[nb]), fill = new Int32Array(nb);
   var W = ctx.W, H = ctx.H;
   for (var j = j0; j <= j1; ++j) {
      var dy = (j + 0.5) * B - s.y, yn = ((j + 0.5) * B) / H - 0.5;
      for (var i = i0; i <= i1; ++i) {
         var q = (j - j0) * bw + (i - i0), b = binOf[q];
         if (b < 0) continue;
         var p = j * w + i;
         var v = ctx.M[p] - HR.planeAt(ctx.plane, ((i + 0.5) * B) / W - 0.5, yn) - ctx.T[p];
         vals[offs[b] + fill[b]++] = v;
      }
   }
   var prof = { r: [], med: [], err: [], n: [] };
   for (var b = 0; b < nb; ++b) {
      prof.r.push(Math.sqrt(edges[b] * edges[b + 1]));
      if (counts[b] < 30) { prof.med.push(NaN); prof.err.push(NaN); prof.n.push(counts[b]); continue; }
      var cm = HR.clippedMedian(vals.subarray(offs[b], offs[b + 1]));
      prof.med.push(cm.med); prof.err.push(1.2533 * cm.sigma / Math.sqrt(Math.max(cm.n, 1))); prof.n.push(cm.n);
   }
   return prof;
};

// Least squares  y = s + A*x  (2x2 normal equations).
HR.lin2 = function (x, y) {
   var n = x.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
   for (var i = 0; i < n; ++i) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
   var d = n * sxx - sx * sx;
   if (Math.abs(d) < 1e-30) return null;
   var A = (n * sxy - sx * sy) / d, s = (sy - A * sx) / n, sse = 0;
   for (var i = 0; i < n; ++i) { var e = y[i] - s - A * x[i]; sse += e * e; }
   return { s: s, A: A, sse: sse };
};

// Fit  p = s + A*(r/1000)^-a  on [r0, r1] by a grid over a.
HR.fitTail = function (prof, r0, r1) {
   var rr = [], pp = [];
   for (var i = 0; i < prof.r.length; ++i)
      if (prof.r[i] >= r0 && prof.r[i] <= r1 && isFinite(prof.med[i])) { rr.push(prof.r[i]); pp.push(prof.med[i]); }
   if (rr.length < 6) return null;
   var best = null;
   for (var a = 0.6; a <= 4.0001; a += 0.02) {
      var x = rr.map(function (r) { return Math.pow(r / 1000, -a); });
      var f = HR.lin2(x, pp);
      if (f && f.A > 0 && (!best || f.sse < best.sse)) best = { s: f.s, A: f.A, a: a, sse: f.sse };
   }
   return best;
};

// Weighted log-log power-law fit on positive values in [r0, r1].
HR.fitPowerLaw = function (r, v, r0, r1) {
   var x = [], y = [];
   for (var i = 0; i < r.length; ++i)
      if (r[i] >= r0 && r[i] <= r1 && v[i] > 0 && isFinite(v[i])) { x.push(Math.log(r[i] / 1000)); y.push(Math.log(v[i])); }
   if (x.length < 4) return null;
   var f = HR.lin2(x, y);
   if (!f) return null;
   return { A: Math.exp(f.s), a: -f.A };
};

// Local linear regression in u = ln r with a Gaussian kernel of width sigmaU.
// Where all values under the kernel are significant (> 3 err) the fit runs on
// ln v, so a power law passes unchanged; in the noise it runs on v. A plain
// moving average would flatten the steep inner profile: too low next to the
// core and too high just outside it (the cause of dark rings).
HR.smoothProfile = function (r, v, err, sigmaU) {
   var n = r.length, u = r.map(function (x) { return Math.log(x); }), out = new Array(n), rad = 3 * sigmaU;
   for (var i = 0; i < n; ++i) {
      var useLog = true, near = false;
      for (var j = 0; j < n; ++j) {
         if (!isFinite(v[j]) || Math.abs(u[j] - u[i]) > rad) continue;
         if (Math.abs(u[j] - u[i]) <= sigmaU) near = true;
         if (!(v[j] > 3 * err[j])) useLog = false;
      }
      if (!near) { out[i] = NaN; continue; }
      var S0 = 0, S1 = 0, S2 = 0, T0 = 0, T1 = 0;
      for (var j = 0; j < n; ++j) {
         var d = u[j] - u[i];
         if (!isFinite(v[j]) || Math.abs(d) > rad) continue;
         var w = Math.exp(-0.5 * d * d / (sigmaU * sigmaU)), y = useLog ? Math.log(v[j]) : v[j];
         S0 += w; S1 += w * d; S2 += w * d * d; T0 += w * y; T1 += w * d * y;
      }
      var det = S0 * S2 - S1 * S1;
      var a = det > 1e-9 * S0 * S0 ? (S2 * T0 - S1 * T1) / det : T0 / S0;
      out[i] = useLog ? Math.exp(a) : a;
   }
   return out;
};

// Build a halo model from a measured profile.
HR.buildHalo = function (prof, star, opts) {
   var nb = prof.r.length, rLast = 0;
   for (var i = 0; i < nb; ++i) if (isFinite(prof.med[i])) rLast = prof.r[i];
   var tail = HR.fitTail(prof, rLast / 6, rLast);
   var sky = tail ? tail.s : 0;
   var hraw = prof.med.map(function (m) { return m - sky; });
   var sb = 1 + 6 * opts.smoothing;
   var hs = HR.smoothProfile(prof.r, hraw, prof.err, sb * Math.log(1.035));
   // never above the measured median: an over-estimate digs a dark ring
   for (var i = 0; i < nb; ++i)
      if (isFinite(hs[i]) && isFinite(hraw[i])) hs[i] = Math.min(hs[i], hraw[i] + 2 * prof.err[i]);
   // bins inside the first measured one (core exclusion) keep the first value
   var i0 = 0;
   while (i0 < nb && !isFinite(hs[i0])) ++i0;
   for (var i = 0; i < i0 && i0 < nb; ++i) hs[i] = hs[i0];
   var es = prof.err.map(function (e) { return e / Math.sqrt(2.5 * sb); });
   // radius where the smoothed profile sinks into the noise
   var iCut = -1, run = 0;
   for (var i = 0; i < nb; ++i) {
      if (!isFinite(hs[i])) continue;
      if (hs[i] < 2 * es[i]) { if (++run >= 3) break; }
      else { run = 0; iCut = i; }
   }
   if (iCut < 3) iCut = Math.min(nb - 1, 3);
   var rCut = prof.r[iCut];
   var tailPL = HR.fitPowerLaw(prof.r, hs, rCut / 3, rCut) ||
                (tail ? { A: tail.A, a: tail.a } : { A: Math.max(hs[iCut], 0) * Math.pow(rCut / 1000, 2), a: 2 });
   tailPL.a = Math.min(Math.max(tailPL.a, 0.5), 5);
   // match amplitude at rCut
   var hc = Math.max(hs[iCut], 0);
   tailPL.A = hc > 0 ? hc / Math.pow(rCut / 1000, -tailPL.a) : 0;
   var halo = {
      mode: opts.mode, r: prof.r.slice(0, iCut + 1), h: [], rIn: star.rIn, rCut: rCut,
      tail: tailPL, rTaper0: star.rFit, rEnd: 1.5 * star.rFit, sky: sky, fitTail: tail
   };
   for (var i = 0; i <= iCut; ++i) halo.h.push(Math.max(isFinite(hs[i]) ? hs[i] : 0, 0));
   if (opts.mode == HR.MODE_POWERLAW) {
      var rp0 = Math.max(star.rIn, opts.protectRadius * star.radiusScale * 0.5);
      halo.pl = HR.fitPowerLaw(prof.r, hs, rp0, rCut) || tailPL;
   }
   return halo;
};

// Power-law mode never exceeds the measured profile: a law fitted on the
// outskirts is too steep near the core and would dig holes there.
HR.evalHalo = function (H, r) {
   var v = HR.evalEmpirical(H, r);
   if (H.mode == HR.MODE_POWERLAW && H.pl)
      v = Math.min(v, H.pl.A * Math.pow(Math.max(r, H.rIn) / 1000, -H.pl.a));
   if (r > H.rTaper0) v *= 1 - HR.smoothstep((r - H.rTaper0) / (H.rEnd - H.rTaper0));
   return v;
};

HR.evalEmpirical = function (H, r) {
   var v;
   if (r <= H.r[0]) {
      v = H.h[0];
   } else if (r <= H.rCut) {
      var b = HR.upperBound(H.r, 0, H.r.length, r) - 1;
      if (b >= H.r.length - 1) v = H.h[H.h.length - 1];
      else {
         var t = Math.log(r / H.r[b]) / Math.log(H.r[b + 1] / H.r[b]);
         v = H.h[b] + t * (H.h[b + 1] - H.h[b]);
      }
   } else {
      v = H.tail.A * Math.pow(r / 1000, -H.tail.a);
   }
   return v;
};

// Lookup table over integer radius (full-resolution pixels), optional weight fn.
HR.buildLut = function (H, weight) {
   var n = Math.ceil(H.rEnd) + 2, lut = new Float32Array(n);
   for (var r = 0; r < n; ++r) lut[r] = HR.evalHalo(H, r) * (weight ? weight(r) : 1);
   lut[n - 1] = 0; lut[n - 2] = 0;
   return lut;
};

HR.lutAt = function (lut, r) {
   var i = Math.floor(r);
   if (i >= lut.length - 1) return 0;
   var f = r - i;
   return lut[i] + f * (lut[i + 1] - lut[i]);
};

// Reduction weight: inner -> outer amount over the transition, times a core
// factor 1 - p*(1 - taper); the taper is 0 inside coreProtect * rcore and 1 from
// twice that radius, p = coreOpacity.
HR.weightFn = function (star, opts) {
   var rp = opts.protectRadius * star.radiusScale, tw = Math.max(opts.transition * star.radiusScale, 1);
   var a0 = opts.innerAmount, a1 = opts.outerAmount, rc = opts.coreProtect * star.rcore, op = opts.coreOpacity;
   return function (r) {
      var w = a0 + (a1 - a0) * HR.smoothstep((r - rp) / tw);
      return rc > 0 ? w * (1 - op * (1 - HR.smoothstep(r / rc - 1))) : w;
   };
};

// Add sign * lut(r) of a star to a binned array.
HR.addLut = function (T, w, h, B, star, lut, sign) {
   var R = lut.length - 2;
   var i0 = Math.max(0, Math.floor((star.x - R) / B)), i1 = Math.min(w - 1, Math.ceil((star.x + R) / B));
   var j0 = Math.max(0, Math.floor((star.y - R) / B)), j1 = Math.min(h - 1, Math.ceil((star.y + R) / B));
   for (var j = j0; j <= j1; ++j) {
      var dy = (j + 0.5) * B - star.y;
      for (var i = i0; i <= i1; ++i) {
         var dx = (i + 0.5) * B - star.x, r = Math.sqrt(dx * dx + dy * dy);
         if (r < R) T[j * w + i] += sign * HR.lutAt(lut, r);
      }
   }
};

// Clipped least-squares plane on  M - T  over non-excluded pixels.
HR.fitPlane = function (ctx) {
   var w = ctx.w, h = ctx.h, B = ctx.B, W = ctx.W, H = ctx.H;
   var pl = { a: 0, b: 0, c: 0 }, sig = Infinity;
   // initial level: clipped median of a subsample
   var sub = [];
   for (var p = 0; p < w * h; p += 7) if (!ctx.excl[p]) sub.push(ctx.M[p] - ctx.T[p]);
   var cm = HR.clippedMedian(new Float32Array(sub));
   pl.a = cm.med; sig = cm.sigma;
   for (var it = 0; it < 3; ++it) {
      var S = [0, 0, 0, 0, 0, 0, 0, 0, 0], V = [0, 0, 0], res2 = 0, nn = 0;
      for (var j = 0; j < h; j += 2) {
         var y = ((j + 0.5) * B) / H - 0.5;
         for (var i = 0; i < w; i += 2) {
            var p = j * w + i;
            if (ctx.excl[p]) continue;
            var x = ((i + 0.5) * B) / W - 0.5, v = ctx.M[p] - ctx.T[p];
            var e = v - HR.planeAt(pl, x, y);
            if (Math.abs(e) > 3 * sig) continue;
            var f = [1, x, y];
            for (var a = 0; a < 3; ++a) { V[a] += f[a] * v; for (var b = 0; b < 3; ++b) S[3 * a + b] += f[a] * f[b]; }
            res2 += e * e; ++nn;
         }
      }
      var sol = HR.solve3(S, V);
      if (!sol) break;
      pl = { a: sol[0], b: sol[1], c: sol[2] };
      sig = Math.sqrt(res2 / Math.max(nn, 1));
   }
   return pl;
};

HR.solve3 = function (S, V) {
   var m = [[S[0], S[1], S[2], V[0]], [S[3], S[4], S[5], V[1]], [S[6], S[7], S[8], V[2]]];
   for (var c = 0; c < 3; ++c) {
      var piv = c;
      for (var r = c + 1; r < 3; ++r) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      var t = m[c]; m[c] = m[piv]; m[piv] = t;
      if (Math.abs(m[c][c]) < 1e-30) return null;
      for (var r = 0; r < 3; ++r) {
         if (r == c) continue;
         var f = m[r][c] / m[c][c];
         for (var k = c; k < 4; ++k) m[r][k] -= f * m[c][k];
      }
   }
   return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
};

// Exclusion map: user mask, saturated pixels, cores of all stars.
HR.buildExclusion = function (mx, userMask, w, h, B, stars, opts) {
   var ex = new Uint8Array(w * h);
   for (var p = 0; p < w * h; ++p) ex[p] = (mx[p] >= opts.satLevel * 0.9 || (userMask && userMask[p] > 0.5)) ? 1 : 0;
   for (var k = 0; k < stars.length; ++k) {
      var s = stars[k], R = Math.max(3 * s.rcore, s.rIn);
      var i0 = Math.max(0, Math.floor((s.x - R) / B)), i1 = Math.min(w - 1, Math.ceil((s.x + R) / B));
      var j0 = Math.max(0, Math.floor((s.y - R) / B)), j1 = Math.min(h - 1, Math.ceil((s.y + R) / B));
      for (var j = j0; j <= j1; ++j)
         for (var i = i0; i <= i1; ++i) {
            var dx = (i + 0.5) * B - s.x, dy = (j + 0.5) * B - s.y;
            if (dx * dx + dy * dy < R * R) ex[j * w + i] = 1;
         }
   }
   return ex;
};

// Joint fit of all stars + sky plane for one channel.
// M: binned mean, mx: binned max (all channels), userMask: binned mask or null.
HR.fitChannel = function (M, mx, userMask, dims, stars, opts, log) {
   var ctx = {
      M: M, w: dims.w, h: dims.h, B: dims.B, W: dims.W, H: dims.H, stars: stars,
      T: new Float32Array(dims.w * dims.h), plane: { a: 0, b: 0, c: 0 }, rawLuts: [], halos: []
   };
   ctx.excl = HR.buildExclusion(mx, userMask, ctx.w, ctx.h, ctx.B, stars, opts);
   ctx.plane = HR.fitPlane(ctx);
   for (var it = 0; it < opts.iterations; ++it) {
      for (var k = 0; k < stars.length; ++k) {
         if (ctx.rawLuts[k]) HR.addLut(ctx.T, ctx.w, ctx.h, ctx.B, stars[k], ctx.rawLuts[k], -1);
         var prof = HR.measureProfile(ctx, k);
         var halo = HR.buildHalo(prof, stars[k], opts);
         halo.prof = prof;
         ctx.halos[k] = halo;
         ctx.rawLuts[k] = HR.buildLut(halo, null);
         HR.addLut(ctx.T, ctx.w, ctx.h, ctx.B, stars[k], ctx.rawLuts[k], +1);
      }
      ctx.plane = HR.fitPlane(ctx);
      if (log) log(it, ctx);
   }
   return { halos: ctx.halos, plane: ctx.plane };
};

// Weighted LUTs for rendering (enabled stars only).
HR.renderLuts = function (fit, stars, opts) {
   var out = [];
   for (var k = 0; k < stars.length; ++k) {
      if (!stars[k].enabled || !fit.halos[k]) { out.push(null); continue; }
      out.push(HR.buildLut(fit.halos[k], HR.weightFn(stars[k], opts)));
   }
   return out;
};

// Binned preview:  M - sum_k w*halo_k
HR.renderBinned = function (M, dims, stars, luts) {
   var out = new Float32Array(M);
   for (var k = 0; k < stars.length; ++k)
      if (luts[k]) HR.addLut(out, dims.w, dims.h, dims.B, stars[k], luts[k], -1);
   return out;
};

// Subtract weighted halos from one full-resolution row block in place.
// buf holds rows [y0, y0+nRows) of width W.
HR.subtractRows = function (buf, W, y0, nRows, stars, luts, sign) {
   for (var k = 0; k < stars.length; ++k) {
      var lut = luts[k];
      if (!lut) continue;
      var s = stars[k], R = lut.length - 2;
      for (var jr = 0; jr < nRows; ++jr) {
         var dy = (y0 + jr + 0.5) - (s.y + 0.5);
         if (Math.abs(dy) >= R) continue;
         var half = Math.sqrt(R * R - dy * dy);
         var x0 = Math.max(0, Math.floor(s.x - half)), x1 = Math.min(W - 1, Math.ceil(s.x + half));
         var base = jr * W, dy2 = dy * dy;
         for (var x = x0; x <= x1; ++x) {
            var dx = x - s.x, r = Math.sqrt(dx * dx + dy2);
            var i = r | 0;
            if (i >= R) continue;
            buf[base + x] -= sign * (lut[i] + (r - i) * (lut[i + 1] - lut[i]));
         }
      }
   }
};
// ENGINE-END

// ----------------------------------------------------------------------------
// PixInsight I/O
// ----------------------------------------------------------------------------

// Binned mean per channel and binned max over all channels.
function hrReadBinned(image, B) {
   var W = image.width, H = image.height, nc = image.numberOfChannels;
   var w = Math.floor(W / B), h = Math.floor(H / B), inv = 1 / (B * B);
   var buf = new Float32Array(W * B), mx = new Float32Array(w * h), means = [];
   for (var c = 0; c < nc; ++c) {
      var m = new Float32Array(w * h);
      for (var j = 0; j < h; ++j) {
         image.getSamples(buf, new Rect(0, j * B, W, j * B + B), c);
         for (var i = 0; i < w; ++i) {
            var s = 0, mm = -Infinity;
            for (var yy = 0; yy < B; ++yy) {
               var o = yy * W + i * B;
               for (var xx = 0; xx < B; ++xx) { var v = buf[o + xx]; s += v; if (v > mm) mm = v; }
            }
            m[j * w + i] = s * inv;
            if (mm > mx[j * w + i]) mx[j * w + i] = mm;
         }
      }
      means.push(m);
      processEvents();
   }
   return { means: means, mx: mx, dims: { w: w, h: h, B: B, W: W, H: H }, nc: nc };
}

// Binned max of the (optionally inverted) mask: a bin is excluded if any pixel is.
function hrReadMaskBinned(image, B, w, h, invert) {
   var W = image.width, buf = new Float32Array(W * B), out = new Float32Array(w * h);
   for (var j = 0; j < h; ++j) {
      image.getSamples(buf, new Rect(0, j * B, W, j * B + B), 0);
      for (var i = 0; i < w; ++i) {
         var mm = 0;
         for (var yy = 0; yy < B; ++yy) for (var xx = 0; xx < B; ++xx) {
            var v = buf[yy * W + i * B + xx];
            mm = Math.max(mm, invert ? 1 - v : v);
         }
         out[j * w + i] = mm;
      }
   }
   return out;
}

// Refine a star centre on full-resolution data: centroid of saturated pixels.
function hrRefineCentre(image, star, sat) {
   var R = Math.ceil(star.rcore * 2 + 16);
   var x0 = Math.max(0, Math.floor(star.x - R)), x1 = Math.min(image.width, Math.ceil(star.x + R));
   var y0 = Math.max(0, Math.floor(star.y - R)), y1 = Math.min(image.height, Math.ceil(star.y + R));
   var bw = x1 - x0, bh = y1 - y0, buf = new Float32Array(bw * bh);
   var sx = 0, sy = 0, n = 0;
   for (var c = 0; c < image.numberOfChannels; ++c) {
      image.getSamples(buf, new Rect(x0, y0, x1, y1), c);
      for (var j = 0; j < bh; ++j) for (var i = 0; i < bw; ++i)
         if (buf[j * bw + i] >= sat) { sx += x0 + i + 0.5; sy += y0 + j + 0.5; ++n; }
   }
   if (n > 0) { star.x = sx / n - 0.5; star.y = sy / n - 0.5; }
}

// Binned exclusion mask of view mv (null for none).
function hrMaskFor(mv, b, invert) {
   if (!mv || mv.isNull) return null;
   if (mv.image.width != b.dims.W || mv.image.height != b.dims.H) throw new Error("Exclusion mask size differs from the target.");
   var mask = hrReadMaskBinned(mv.image, b.dims.B, b.dims.w, b.dims.h, invert);
   var nx = 0; for (var p = 0; p < mask.length; ++p) if (mask[p] > 0.5) ++nx;
   console.writeln(format(HR_TITLE + ": exclusion mask covers %.1f%% of the image.", 100 * nx / mask.length));
   if (nx > 0.8 * mask.length) throw new Error("Exclusion mask covers more than 80% of the image. Tick 'Invert'?");
   return mask;
}

// Joint fit of all stars, every channel.
function hrFitAll(b, stars, opts, mask) {
   var fits = [];
   for (var c = 0; c < b.nc; ++c) {
      console.writeln(format(HR_TITLE + ": fitting channel %d ...", c));
      fits.push(HR.fitChannel(b.means[c], b.mx, mask, b.dims, stars, opts, function (it, ctx) {
         console.writeln(format("  iter %d  plane a=%.3e b=%.3e c=%.3e", it, ctx.plane.a, ctx.plane.b, ctx.plane.c));
         processEvents();
      }));
      for (var k = 0; k < stars.length; ++k) {
         var H = fits[c].halos[k];
         console.writeln(format("    star %d (%.0f,%.0f): sky %.3e, rCut %.0f px, tail a=%.2f, halo@1000px %.3e",
            k + 1, stars[k].x, stars[k].y, H.sky, H.rCut, H.tail.a, HR.evalHalo(H, 1000)));
      }
   }
   return fits;
}

// Subtract the weighted halos from the image of view v in place, at full
// resolution. Call between beginProcess and endProcess. The removed halo goes
// to model view mv when given.
function hrSubtractView(v, fits, stars, opts, mv) {
   var img = v.image, W = img.width, H = img.height, nc = img.numberOfChannels;
   HR.starGeometry(stars, opts);
   var RB = 64, buf = new Float32Array(W * RB);
   for (var c = 0; c < nc; ++c) {
      var luts = HR.renderLuts(fits[c], stars, opts);
      for (var y0 = 0; y0 < H; y0 += RB) {
         var n = Math.min(RB, H - y0), rect = new Rect(0, y0, W, y0 + n);
         var b = n == RB ? buf : new Float32Array(W * n);
         img.getSamples(b, rect, c);
         HR.subtractRows(b, W, y0, n, stars, luts, +1);
         for (var i = 0; i < b.length; ++i) if (b[i] < 0) b[i] = 0;
         img.setSamples(b, rect, c);
         if (mv) {
            var m = new Float32Array(W * n);
            HR.subtractRows(m, W, y0, n, stars, luts, -1);
            mv.image.setSamples(m, rect, c);
         }
      }
      processEvents();
   }
}

// Script parameters. PixInsight stores them in the Script entry of the
// processing history and in process icons; executing that entry or icon on a
// view runs hrExecuteOn() with them.
var HR_INT_OPTS = { bin: 1, maxStars: 1, iterations: 1, mode: 1 };

function hrSaveParameters(opts, stars, extra) {
   Parameters.clear();
   Parameters.set("version", HR_VERSION);
   for (var k in opts) Parameters.set(k, opts[k]);
   function r2(v) { return Math.round(v * 100) / 100; }
   Parameters.set("stars", JSON.stringify(stars.map(function (s) {
      var o = { x: r2(s.x), y: r2(s.y), rcore: r2(s.rcore), enabled: s.enabled, manual: s.manual };
      if (s.det) o.det = { x: r2(s.det.x), y: r2(s.det.y), rcore: r2(s.det.rcore) };
      return o;
   })));
   if (extra.maskId) Parameters.set("maskId", extra.maskId);
   Parameters.set("invertMask", extra.invert);
   Parameters.set("replaceTarget", extra.replace);
   Parameters.set("createModel", extra.model);
}

function hrLoadParameters() {
   var o = HR.defaults();
   for (var k in o) {
      if (!Parameters.has(k)) continue;
      if (typeof o[k] == "boolean") o[k] = Parameters.getBoolean(k);
      else o[k] = HR_INT_OPTS[k] ? Math.round(Parameters.getReal(k)) : Parameters.getReal(k);
   }
   return {
      opts: o,
      stars: Parameters.has("stars") ? JSON.parse(Parameters.getString("stars")) : [],
      maskId: Parameters.has("maskId") ? Parameters.getString("maskId") : "",
      invert: Parameters.has("invertMask") ? Parameters.getBoolean("invertMask") : false,
      replace: Parameters.has("replaceTarget") ? Parameters.getBoolean("replaceTarget") : true,
      model: Parameters.has("createModel") ? Parameters.getBoolean("createModel") : false
   };
}

// Run without the dialog (Script entry or icon executed on a view): fit with
// the saved parameters and stars, then replace the view.
function hrExecuteOn(v, p) {
   var t = Date.now(), opts = p.opts;
   console.writeln("<end><cbr>" + HR_TITLE + " " + HR_VERSION + ": " + v.id + " with saved parameters.");
   var b = hrReadBinned(v.image, opts.bin);
   var stars = p.stars;
   if (stars.length == 0) {
      stars = HR.detectStars(b.mx, b.dims.w, b.dims.h, b.dims.B, opts);
      for (var i = 0; i < stars.length; ++i) hrRefineCentre(v.image, stars[i], opts.satLevel);
   }
   if (stars.length == 0) throw new Error("No halo stars on " + v.id + ".");
   HR.starGeometry(stars, opts);
   var mv = null;
   if (p.maskId) {
      mv = View.viewById(p.maskId);
      if (!mv || mv.isNull) throw new Error("Exclusion mask " + p.maskId + " is not open.");
   }
   var fits = hrFitAll(b, stars, opts, hrMaskFor(mv, b, p.invert));
   v.beginProcess(UndoFlag_DefaultMode);
   try { hrSubtractView(v, fits, stars, opts, null); } finally { v.endProcess(); }
   console.writeln(format(HR_TITLE + ": replaced %s in %.1f s.", v.id, (Date.now() - t) / 1000));
}

// ----------------------------------------------------------------------------
// Embedded preview
// ----------------------------------------------------------------------------

var HR_VIEW_AFTER = 0, HR_VIEW_BEFORE = 1, HR_VIEW_MODEL = 2;
var HR_PREVIEW_MAX = 1500;   // longest side of the preview grid (px)

// Preview data on a display grid: binned image decimated by D.
function hrMakeDisplay(binned) {
   var d = binned.dims, D = Math.max(1, Math.ceil(Math.max(d.w, d.h) / HR_PREVIEW_MAX));
   var dw = Math.floor(d.w / D), dh = Math.floor(d.h / D), inv = 1 / (D * D), before = [];
   for (var c = 0; c < binned.nc; ++c) {
      var src = binned.means[c], out = new Float32Array(dw * dh);
      for (var j = 0; j < dh; ++j)
         for (var i = 0; i < dw; ++i) {
            var s = 0;
            for (var yy = 0; yy < D; ++yy) { var o = (j * D + yy) * d.w + i * D; for (var xx = 0; xx < D; ++xx) s += src[o + xx]; }
            out[j * dw + i] = s * inv;
         }
      before.push(out);
   }
   // background level and noise of the display grid (subsampled)
   var stats = [];
   for (var c = 0; c < binned.nc; ++c) {
      var a = before[c], n = a.length, sub = new Float32Array(Math.ceil(n / 3)), k = 0;
      for (var p = 0; p < n; p += 3) sub[k++] = a[p];
      sub = HR.sortTyped(sub.subarray(0, k));
      var med = sub[k >> 1];
      for (var i = 0; i < k; ++i) sub[i] = Math.abs(sub[i] - med);
      HR.sortTyped(sub);
      stats.push({ med: med, sigma: 1.4826 * sub[k >> 1] });
   }
   return { w: dw, h: dh, scale: d.B * D, nc: binned.nc, before: before, stats: stats, model: null };
}

// Removed halo (weighted model) on the display grid.
function hrDisplayModel(disp, fits, stars, opts) {
   var model = [];
   for (var c = 0; c < disp.nc; ++c) {
      var m = new Float32Array(disp.w * disp.h);
      if (fits) {
         var luts = HR.renderLuts(fits[c], stars, opts);
         for (var k = 0; k < stars.length; ++k)
            if (luts[k]) HR.addLut(m, disp.w, disp.h, disp.scale, stars[k], luts[k], +1);
      }
      model.push(m);
   }
   return model;
}

// STF on a linear value: shadows clip c0, midtones m.
function hrStretch(v, c0, m) {
   var x = (v - c0) / (1 - c0);
   if (x <= 0) return 0;
   if (x >= 1) return 1;
   return (m - 1) * x / ((2 * m - 1) * x - m);
}

// Bitmap for a view mode. The sky level comes from the fitted plane when
// available, so before/after share one stretch and the halo is visible.
function hrRenderBitmap(disp, mode, hard, fits) {
   var nc = disp.nc, n = disp.w * disp.h;
   if (!disp.image || disp.image.width != disp.w || disp.image.height != disp.h)
      disp.image = new Image(disp.w, disp.h, nc, nc == 3 ? ColorSpace_RGB : ColorSpace_Gray, 32, SampleType_Real);
   var out = new Float32Array(n);
   for (var c = 0; c < nc; ++c) {
      var sky = fits ? fits[c].plane.a : disp.stats[c].med, sig = disp.stats[c].sigma;
      var src = disp.before[c], mdl = disp.model ? disp.model[c] : null;
      if (mode == HR_VIEW_MODEL) {
         var mx = 0;
         for (var p = 0; p < n; ++p) if (mdl && mdl[p] > mx) mx = mdl[p];
         var mm = HR_mtfFor(hard ? 0.5 : 0.3, 30 * sig / Math.max(mx, 1e-12));
         for (var p = 0; p < n; ++p) out[p] = mdl && mx > 0 ? hrStretch(mdl[p] / mx, 0, mm) : 0;
      } else {
         var c0 = sky - (hard ? 1.5 : 2.8) * sig;
         var m = HR_mtfFor(hard ? 0.35 : 0.2, (sky - c0) / (1 - c0));
         for (var p = 0; p < n; ++p) {
            var v = src[p];
            if (mode == HR_VIEW_AFTER && mdl) v -= mdl[p];
            out[p] = hrStretch(v, c0, m);
         }
      }
      disp.image.setSamples(out, new Rect(0, 0, disp.w, disp.h), c);
   }
   return disp.image.render();
}

// Midtones balance that maps x to target t.
function HR_mtfFor(t, x) {
   x = Math.min(Math.max(x, 1e-7), 1 - 1e-7);
   return Math.mtf(t, x);
}

function HRPreviewControl(parent, dlg) {
   this.__base__ = Control;
   this.__base__(parent);
   var self = this;
   this.dlg = dlg;
   this.bitmap = null;     // display bitmap
   this.disp = null;       // display data (for coordinates)
   this.scale = 0;         // screen px per display px, 0 = fit
   this.ox = 0; this.oy = 0;   // display px at the control's top-left
   this.drag = null;
   this.move = null;       // star moved with Alt+drag
   this.showRadii = true;
   this.message = "Open a linear image and press Fit.";
   this.setScaledMinSize(720, 540);
   this.cursor = new Cursor(StdCursor_Cross);
   this.focusStyle = FocusStyle_Click | FocusStyle_Wheel;   // Space needs keyboard focus
   this.onEnter = function () { this.hasFocus = true; };

   // Keep the full-resolution point (ix, iy) in the middle of the control (zoomed views only).
   this.centerOn = function (ix, iy) {
      if (!this.disp || this.scale <= 0) return;
      var s = this.scale;
      this.ox = ix / this.disp.scale - this.width / s / 2; this.oy = iy / this.disp.scale - this.height / s / 2;
      this.clampPan(); this.update();
   };

   this.fitScale = function () {
      if (!this.disp) return 1;
      return Math.min(this.width / this.disp.w, this.height / this.disp.h);
   };
   this.currentScale = function () { return this.scale > 0 ? this.scale : this.fitScale(); };
   this.clampPan = function () {
      if (!this.disp) return;
      var s = this.currentScale(), vw = this.width / s, vh = this.height / s;
      this.ox = vw >= this.disp.w ? -(vw - this.disp.w) / 2 : Math.min(Math.max(this.ox, 0), this.disp.w - vw);
      this.oy = vh >= this.disp.h ? -(vh - this.disp.h) / 2 : Math.min(Math.max(this.oy, 0), this.disp.h - vh);
   };
   // control px -> full-resolution image px
   this.toImage = function (x, y) {
      var s = this.currentScale();
      return { x: (this.ox + x / s) * this.disp.scale, y: (this.oy + y / s) * this.disp.scale };
   };
   this.toControl = function (ix, iy) {
      var s = this.currentScale();
      return { x: (ix / this.disp.scale - this.ox) * s, y: (iy / this.disp.scale - this.oy) * s };
   };

   this.setBitmap = function (bmp, disp) {
      var first = !this.disp || this.disp.w != disp.w || this.disp.h != disp.h;
      this.bitmap = bmp; this.disp = disp;
      if (first) { this.scale = 0; this.clampPan(); }
      this.update();
   };

   this.onResize = function () { this.clampPan(); this.update(); };

   this.onPaint = function () {
      var g = new Graphics(this);
      g.fillRect(this.boundsRect, new Brush(0xff181818));
      if (this.bitmap && this.disp) {
         this.clampPan();
         var s = this.currentScale();
         var sx0 = Math.max(0, this.ox), sy0 = Math.max(0, this.oy);
         var sx1 = Math.min(this.disp.w, this.ox + this.width / s), sy1 = Math.min(this.disp.h, this.oy + this.height / s);
         var dst = new Rect((sx0 - this.ox) * s, (sy0 - this.oy) * s, (sx1 - this.ox) * s, (sy1 - this.oy) * s);
         g.drawScaledBitmapRect(dst, this.bitmap, new Rect(sx0, sy0, sx1, sy1));
         if (this.showRadii) this.paintStars(g);
      }
      if (this.message) {
         g.pen = new Pen(0xffffd060);
         g.drawText(8, this.height - 8, this.message);
      }
      g.end();
   };

   this.paintStars = function (g) {
      var stars = this.dlg.stars, opts = this.dlg.opts;
      g.antialiasing = true;
      for (var k = 0; k < stars.length; ++k) {
         var st = stars[k], c = this.toControl(st.x, st.y), s = this.currentScale() / this.disp.scale;
         if (st === this.dlg.selStar) {
            g.pen = new Pen(0xff40e0ff, 2);
            g.drawCircle(c.x, c.y, Math.max(10, st.rcore * 3 * s));
         }
         if (!st.enabled) {
            g.pen = new Pen(0xff808080, 1);
            g.drawCircle(c.x, c.y, Math.max(4, st.rcore * 3 * s));
            continue;
         }
         var rs = st.radiusScale || 1, rp = opts.protectRadius * rs, rf = rp + opts.transition * rs;
         g.pen = new Pen(0xffffc040, 1, PenStyle_Dash);
         g.drawCircle(c.x, c.y, Math.max(3, rp * s));
         g.pen = new Pen(0xff40e060, 1, PenStyle_Dash);
         g.drawCircle(c.x, c.y, Math.max(5, rf * s));
         g.pen = new Pen(0xffff4040, 1);
         g.drawLine(c.x - 6, c.y, c.x + 6, c.y); g.drawLine(c.x, c.y - 6, c.x, c.y + 6);
         g.drawText(c.x + 8, c.y - 8, String(k + 1));
      }
   };

   this.onMouseWheel = function (x, y, delta, buttonState, modifiers) {
      if (!this.disp) return;
      // Ctrl+wheel resizes. Qt turns Alt+wheel into a horizontal wheel, so Alt+wheel works only on some systems.
      if (modifiers & (KeyModifier_Control | KeyModifier_Alt)) {
         if (delta != 0) this.dlg.resizeStar(delta > 0 ? 1.05 : 1 / 1.05);
         return;
      }
      var s0 = this.currentScale(), fs = this.fitScale();
      var s1 = delta > 0 ? s0 * 1.25 : s0 / 1.25;
      s1 = Math.min(Math.max(s1, fs / 4), 8);   // below fit: space around the image for stars outside it
      var px = this.ox + x / s0, py = this.oy + y / s0;   // keep the point under the cursor
      this.scale = (Math.abs(s1 - fs) < 1e-6) ? 0 : s1;
      this.ox = px - x / s1; this.oy = py - y / s1;
      this.clampPan(); this.update();
   };

   this.onMousePress = function (x, y, button, buttonState, modifiers) {
      if (!this.disp) return;
      this.hasFocus = true;
      if (button == MouseButton_Left && (modifiers & KeyModifier_Alt)) {
         var st = this.dlg.editableStar();
         if (!st) return;
         this.move = st;
         this.moveStar(x, y);
         return;
      }
      if (button == MouseButton_Left && (modifiers & KeyModifier_Control)) {
         this.dlg.toggleBeforeAfter();
         return;
      }
      if (button == MouseButton_Left && (modifiers & KeyModifier_Shift)) {
         var p = this.toImage(x, y);
         this.dlg.addStar(p.x, p.y);
         return;
      }
      this.drag = { x: x, y: y, ox: this.ox, oy: this.oy };
   };
   // The moved star follows the cursor. It can leave the image: a star outside the frame whose halo
   // reaches into it.
   this.moveStar = function (x, y) {
      var p = this.toImage(x, y);
      this.move.x = p.x; this.move.y = p.y;
      this.update();
   };
   this.onMouseMove = function (x, y, buttonState, modifiers) {
      if (!this.disp) return;
      if (this.move) this.moveStar(x, y);
      else if (this.drag) {
         var s = this.currentScale();
         this.ox = this.drag.ox - (x - this.drag.x) / s;
         this.oy = this.drag.oy - (y - this.drag.y) / s;
         this.clampPan(); this.update();
      }
      var p = this.toImage(x, y);
      this.dlg.cursorLabel.text = format("x %d  y %d", Math.round(p.x), Math.round(p.y));
   };
   this.onMouseRelease = function () {
      this.drag = null;
      if (this.move) { var st = this.move; this.move = null; this.dlg.starMoved(st); }
   };
   this.onKeyPress = function (key, modifiers) {
      if (key == Key_Space) this.dlg.cycleStar((modifiers & KeyModifier_Shift) ? -1 : 1);
      else if (key == Key_Plus || key == Key_Equal) this.dlg.resizeStar(1.02);
      else if (key == Key_Minus || key == Key_Underscore) this.dlg.resizeStar(1 / 1.02);
   };
   this.onMouseDoubleClick = function () { this.scale = 0; this.clampPan(); this.update(); };
}
HRPreviewControl.prototype = new Control;

// ----------------------------------------------------------------------------
// Dialog
// ----------------------------------------------------------------------------

function DehaloDialog() {
   this.__base__ = Dialog;
   this.__base__();
   var self = this;
   this.opts = HR.defaults();
   this.stars = [];
   this.binned = null;     // { means, mx, dims, nc, viewId }
   this.disp = null;       // preview display data
   this.fits = null;       // per channel fit results
   this.viewMode = HR_VIEW_AFTER;
   this.hardStretch = false;
   this.windowTitle = HR_TITLE + " " + HR_VERSION;
   var labelW = this.font.width("Core protection (x core r):M");

   function nc(label, min, max, prec, value, tip, onChange) {
      var c = new NumericControl(self);
      c.label.text = label; c.label.minWidth = labelW;
      c.setRange(min, max); c.slider.setRange(0, 1000); c.slider.minWidth = 160;
      c.setPrecision(prec); c.setValue(value); c.toolTip = tip;
      c.onValueUpdated = onChange;
      return c;
   }
   function row() { var s = new HorizontalSizer; s.spacing = 6; for (var i = 0; i < arguments.length; ++i) s.add(arguments[i]); return s; }
   function label(t) { var l = new Label(self); l.text = t; l.minWidth = labelW; l.textAlignment = TextAlign_Right | TextAlign_VertCenter; return l; }
   function reduction(set) { return function (v) { set(v); self.schedulePreview(true); }; }

   // --- header ---
   this.headerLabel = new Label(this);
   this.headerLabel.backgroundColor = 0xffffd700; this.headerLabel.textColor = 0xff4b0082;
   this.headerLabel.useRichText = true; this.headerLabel.margin = 4;
   this.headerLabel.textAlignment = TextAlign_Center | TextAlign_VertCenter;
   this.headerLabel.text = "<b>" + HR_TITLE + " - Version " + HR_VERSION + "</b>";

   // --- help ---
   this.helpLabel = new Label(this);
   this.helpLabel.frameStyle = FrameStyle_Box; this.helpLabel.margin = 6; this.helpLabel.wordWrapping = true; this.helpLabel.useRichText = true;
   this.helpLabel.text = "<b>" + HR_TITLE + "</b> models azimuthal halos of bright stars and subtracts them from " +
      "<b>linear</b> data. Stars are detected and fitted automatically; reduction sliders update the preview live.<br/>" +
      "Preview: wheel zoom, drag pan, double-click fit view, <b>Ctrl+click</b> before/after, <b>Shift+click</b> add star, " +
      "<b>Space</b> select next star, <b>Alt+drag</b> move and <b>Ctrl+wheel</b> or <b>+/-</b> resize the selected star.<br/><br/>" + HR_COPYRIGHT;

   // --- target + mask ---
   this.targetList = new ViewList(this);
   this.targetList.getMainViews();
   if (!ImageWindow.activeWindow.isNull) this.targetList.currentView = ImageWindow.activeWindow.mainView;
   this.targetList.onViewSelected = function () {
      self.binned = null; self.disp = null; self.stars = []; self.fits = null;
      self.refreshStars(); self.loadPreview();
   };
   this.maskList = new ViewList(this);
   this.maskList.getMainViews();
   this.maskList.toolTip = "Optional. White (> 0.5) pixels are excluded from the fit: galaxy, tidal tails, IFN.";
   this.maskList.onViewSelected = function () { self.requestFit(false); };
   this.invertMaskCheck = new CheckBox(this); this.invertMaskCheck.text = "Invert";
   this.invertMaskCheck.toolTip = "Use for protection masks where the structure is black (e.g. a galaxy_protection_mask).";
   this.invertMaskCheck.onCheck = function () { self.requestFit(false); };

   // --- detection (compact edits) ---
   function edit(text, min, max, prec, value, tip, onChange) {
      var e = new NumericEdit(self);
      e.label.text = text; e.setRange(min, max); e.setPrecision(prec); e.setValue(value); e.toolTip = tip;
      e.edit.setFixedWidth(self.font.width("000000"));
      e.onValueUpdated = onChange;
      return e;
   }
   this.binNC = edit("Binning:", 2, 8, 0, this.opts.bin, "Binning used for fitting and preview.", function (v) {
      self.opts.bin = Math.round(v); self.binned = null; self.disp = null; self.fits = null; self.loadPreview();
   });
   this.satNC = edit("Saturation:", 0.5, 1, 3, this.opts.satLevel, "Pixels at or above this value form a saturated core.", function (v) { self.opts.satLevel = v; self.requestFit(true); });
   this.minCoreNC = edit("Min core r:", 2, 60, 0, this.opts.minCoreRadius, "Smallest saturated core radius (px) that counts as a halo star.", function (v) { self.opts.minCoreRadius = v; self.requestFit(true); });
   this.maxStarsNC = edit("Max stars:", 1, 30, 0, this.opts.maxStars, "Largest number of detected stars.", function (v) { self.opts.maxStars = Math.round(v); self.requestFit(true); });

   this.starTree = new TreeBox(this);
   this.starTree.numberOfColumns = 7; this.starTree.headerVisible = true; this.starTree.rootDecoration = false;
   this.starTree.alternateRowColor = true; this.starTree.setScaledMinHeight(170); this.starTree.multipleSelection = true;
   this.starTree.toolTip = "Ticked: the star's halo is reduced. Unticked: the star stays in the fit, its halo stays in the image.";
   ["#", "X", "Y", "Core r", "Fit r", "Tail slope", "Noise r"].forEach(function (t, i) { self.starTree.setHeaderText(i, t); });
   // Custom properties on TreeBoxNode do not survive in PJSR; column 0 holds the 1-based index.
   function nodeIndex(node) { return parseInt(node.text(0), 10) - 1; }
   this.selStar = null;    // star selected in the table, highlighted in the preview
   function syncSelection() {
      if (self.refreshing) return;
      var node = self.starTree.currentNode;
      self.selStar = node ? self.stars[nodeIndex(node)] || null : null;
      if (self.preview) self.preview.update();
   }
   this.starTree.onCurrentNodeUpdated = syncSelection;
   this.starTree.onNodeClicked = syncSelection;
   this.starTree.onNodeSelectionUpdated = syncSelection;
   this.starTree.onNodeUpdated = function (node, col) {
      var s = self.stars[nodeIndex(node)];
      if (s && s.enabled != node.checked) { s.enabled = node.checked; self.schedulePreview(); }
   };

   this.addR = new NumericEdit(this); this.addR.label.text = "Shift+click core r:"; this.addR.setRange(1, 500); this.addR.setPrecision(0); this.addR.setValue(10);
   this.addR.toolTip = "Core radius given to a star added with Shift+click in the preview. It sets the star's size scale.";
   this.removeButton = new PushButton(this); this.removeButton.text = "Remove selected rows";
   this.removeButton.toolTip = "Removes the selected rows (click, Ctrl+click, Shift+click a row) from the model, e.g. a false " +
      "detection or a wrong manual star. To keep a star in the fit but leave its halo, untick it instead.";
   this.removeButton.onClick = function () {
      var drop = {}, n = 0;
      for (var i = 0; i < self.starTree.numberOfChildren; ++i) {
         var node = self.starTree.child(i);
         if (node.selected) { drop[nodeIndex(node)] = true; ++n; }
      }
      if (n == 0) { self.statusLabel.text = "Select one or more rows in the star table first."; return; }
      self.stars = self.stars.filter(function (s, i) { return !drop[i]; });
      self.starsChanged();
   };

   // --- model ---
   this.modeCombo = new ComboBox(this);
   this.modeCombo.addItem("Empirical profile + power-law tail");
   this.modeCombo.addItem("Smooth power law (outskirts)");
   this.modeCombo.currentItem = this.opts.mode;
   this.modeCombo.toolTip = "<p><b>Empirical</b>: measured, smoothed azimuthal profile; follows rings and bumps.</p>" +
      "<p><b>Power law</b>: one A&middot;r<sup>-a</sup> fitted on the outskirts, never above the measured profile; " +
      "smoothest, removes less near the star.</p>";
   this.modeCombo.onItemSelected = function (i) { self.opts.mode = i; self.requestFit(false); };
   this.innerNC = nc("Fit inner radius (x core):", 1, 6, 1, this.opts.innerFactor, "Profile is measured from this multiple of the core radius.", function (v) { self.opts.innerFactor = v; self.requestFit(false); });
   this.fitRNC = nc("Max halo radius (px):", 500, 12000, 0, this.opts.fitRadius, "Halo radius of the brightest star. Other stars scale by core radius. Beyond it the model tapers to zero over 50%.", function (v) { self.opts.fitRadius = v; self.requestFit(false); });
   this.smoothNC = nc("Profile smoothing:", 0, 1, 2, this.opts.smoothing, "Smoothing of the profile: local power-law fit over a window in log radius.", function (v) { self.opts.smoothing = v; self.requestFit(false); });
   this.iterNC = nc("Iterations:", 1, 6, 0, this.opts.iterations, "Joint star + sky plane iterations.", function (v) { self.opts.iterations = Math.round(v); self.requestFit(false); });

   // --- reduction (live) ---
   this.outerNC = nc("Outer reduction:", 0, 1.5, 2, this.opts.outerAmount, "Fraction of the halo removed on the outskirts (1 = all).", reduction(function (v) { self.opts.outerAmount = v; }));
   this.innerAmtNC = nc("Inner reduction:", 0, 1, 2, this.opts.innerAmount, "Fraction of the halo removed close to the star. Lower = more natural halo kept.", reduction(function (v) { self.opts.innerAmount = v; }));
   this.coreNC = nc("Core protection (x core r):", 0, 10, 1, this.opts.coreProtect, "No subtraction inside this multiple of the core radius; full reduction from twice that radius. Keeps the star core and its edge natural. 0: off. Takes effect only with a Core protection opacity above 0.", reduction(function (v) { self.opts.coreProtect = v; }));
   this.coreOpNC = nc("Core protection opacity:", 0, 1, 2, this.opts.coreOpacity, "How much of the core zone is protected. 1: nothing is subtracted inside the zone. Lower values subtract part of the halo there too, so the glow around small stars is weaker and blends into the reduced halo. 0: off.", reduction(function (v) { self.opts.coreOpacity = v; }));
   this.protectNC = nc("Protect radius (px):", 0, 6000, 0, this.opts.protectRadius, "Radius (brightest star) where the reduction starts to grow from inner to outer. Yellow circle.", reduction(function (v) { self.opts.protectRadius = v; }));
   this.transNC = nc("Transition width (px):", 1, 8000, 0, this.opts.transition, "Width of the smooth ramp from inner to outer reduction. Green circle = full outer reduction.", reduction(function (v) { self.opts.transition = v; }));
   this.scaleCheck = new CheckBox(this); this.scaleCheck.text = "Scale radii with star brightness (core radius)";
   this.scaleCheck.checked = this.opts.scaleRadii;
   this.scaleCheck.onCheck = function (c) { self.opts.scaleRadii = c; HR.starGeometry(self.stars, self.opts); self.schedulePreview(); };
   this.modelCheck = new CheckBox(this); this.modelCheck.text = "Also create halo model image"; this.modelCheck.checked = false;
   this.replaceCheck = new CheckBox(this); this.replaceCheck.text = "Replace target image"; this.replaceCheck.checked = true;
   this.replaceCheck.toolTip = "Apply writes the result into the target. The target gets one Dehalo entry in its history " +
      "with all parameters, and Undo restores it. Unticked: Apply creates a new <id>_dehalo image.";
   this.replaceCheck.onCheck = function (c) {
      self.applyButton.toolTip = c ? "Replaces the target image (one Dehalo history entry with the parameters, undoable)."
                                   : "Writes <id>_dehalo at full resolution. The target is not changed.";
   };

   // --- preview ---
   this.preview = new HRPreviewControl(this, this);
   this.viewCombo = new ComboBox(this);
   this.viewCombo.addItem("After"); this.viewCombo.addItem("Before"); this.viewCombo.addItem("Removed halo");
   this.viewCombo.toolTip = "Ctrl+click in the preview switches between After and Before.";
   this.viewCombo.onItemSelected = function (i) { self.viewMode = i; self.renderPreview(false); };
   this.stretchCombo = new ComboBox(this);
   this.stretchCombo.addItem("Normal stretch"); this.stretchCombo.addItem("Hard stretch (faint halo, IFN)");
   this.stretchCombo.onItemSelected = function (i) { self.hardStretch = i == 1; self.renderPreview(false); };
   this.radiiCheck = new CheckBox(this); this.radiiCheck.text = "Radii"; this.radiiCheck.checked = true;
   this.radiiCheck.toolTip = "Yellow: protect radius. Green: full outer reduction. Grey: unticked star.";
   this.radiiCheck.onCheck = function (c) { self.preview.showRadii = c; self.preview.update(); };
   this.cursorLabel = new Label(this); this.cursorLabel.text = ""; this.cursorLabel.minWidth = this.font.width("x 00000  y 00000M");

   this.previewTimer = new Timer(0.15, false);
   this.previewTimer.onTimeout = function () { self.renderPreview(true); };
   this.busy = false;
   this.pendingDetect = false;
   this.editTimer = new Timer(0.35, false);
   this.editTimer.onTimeout = function () {
      self.stars.sort(function (a, b) { return b.rcore - a.rcore; });
      self.starsChanged();
   };
   this.fitTimer = new Timer(0.6, false);
   this.fitTimer.onTimeout = function () { self.runPipeline(); };

   // --- buttons ---
   this.statusLabel = new Label(this); this.statusLabel.text = ""; this.statusLabel.wordWrapping = true; this.statusLabel.useRichText = true;
   this.applyButton = new PushButton(this); this.applyButton.text = "Apply";
   this.applyButton.toolTip = "Replaces the target image (one Dehalo history entry with the parameters, undoable).";
   this.applyButton.onClick = function () { self.apply(); };
   this.closeButton = new PushButton(this); this.closeButton.text = "Close"; this.closeButton.onClick = function () { self.ok(); };
   this.newInstanceButton = new ToolButton(this);
   this.newInstanceButton.icon = this.scaledResource(":/process-interface/new-instance.png");
   this.newInstanceButton.setScaledFixedSize(24, 24);
   this.newInstanceButton.toolTip = "<p>New Instance: drag to the workspace for a process icon, or onto an image to run " +
      "Dehalo with these parameters and stars.</p>";
   this.newInstanceButton.onMousePress = function () { self.saveParameters(); self.newInstance(); };
   this.docButton = new ToolButton(this);
   this.docButton.icon = this.scaledResource(":/process-interface/browse-documentation.png");
   this.docButton.setScaledFixedSize(24, 24);
   this.docButton.toolTip = "<p>Opens the script's documentation.</p>";
   this.docButton.onClick = function () { self.showDocumentation(); };
   this.resetButton = new ToolButton(this);
   this.resetButton.icon = this.scaledResource(":/process-interface/reset.png");
   this.resetButton.setScaledFixedSize(24, 24);
   this.resetButton.toolTip = "<p>Reset parameters to default initial values and detect the stars again. " +
      "Target, mask and Invert do not change.</p>";
   this.resetButton.onClick = function () { self.resetDefaults(); };

   // --- layout ---
   function group(title) { var g = new GroupBox(self); g.title = title; g.sizer = new VerticalSizer; g.sizer.margin = 6; g.sizer.spacing = 4; return g; }
   var gTarget = group("Images");
   gTarget.sizer.add(row(label("Target (linear):"), this.targetList));
   gTarget.sizer.add(row(label("Exclusion mask:"), this.maskList, this.invertMaskCheck));

   var gStars = group("Halo stars (detected automatically)");
   var detRow = new HorizontalSizer; detRow.spacing = 10;
   detRow.add(this.binNC); detRow.add(this.satNC); detRow.add(this.minCoreNC); detRow.add(this.maxStarsNC); detRow.addStretch();
   var addRow = new HorizontalSizer; addRow.spacing = 6;
   addRow.add(this.addR); addRow.addStretch(); addRow.add(this.removeButton);
   gStars.sizer.add(detRow);
   gStars.sizer.add(this.starTree, 100);
   gStars.sizer.add(addRow);

   var gModel = group("Model (refits automatically)");
   gModel.sizer.add(row(label("Approach:"), this.modeCombo));
   gModel.sizer.add(this.innerNC); gModel.sizer.add(this.fitRNC); gModel.sizer.add(this.smoothNC); gModel.sizer.add(this.iterNC);

   var gRed = group("Reduction (live preview)");
   gRed.sizer.add(this.outerNC); gRed.sizer.add(this.innerAmtNC); gRed.sizer.add(this.coreNC); gRed.sizer.add(this.coreOpNC); gRed.sizer.add(this.protectNC); gRed.sizer.add(this.transNC);
   gRed.sizer.add(this.scaleCheck);
   var applyOpts = new HorizontalSizer; applyOpts.spacing = 12;
   applyOpts.add(this.replaceCheck); applyOpts.add(this.modelCheck); applyOpts.addStretch();
   gRed.sizer.add(applyOpts);

   var bRow = new HorizontalSizer; bRow.spacing = 6;
   bRow.add(this.newInstanceButton); bRow.add(this.docButton); bRow.add(this.resetButton);
   bRow.addStretch(); bRow.add(this.applyButton); bRow.add(this.closeButton);

   var left = new VerticalSizer; left.spacing = 6;
   left.add(this.headerLabel); left.add(this.helpLabel); left.add(gTarget); left.add(gStars, 100); left.add(gModel); left.add(gRed);
   left.add(this.statusLabel); left.add(bRow);

   var pBar = new HorizontalSizer; pBar.spacing = 6;
   pBar.add(this.viewCombo); pBar.add(this.stretchCombo); pBar.add(this.radiiCheck);
   pBar.addStretch(); pBar.add(this.cursorLabel);
   var right = new VerticalSizer; right.spacing = 4;
   right.add(pBar); right.add(this.preview, 100);

   this.sizer = new HorizontalSizer; this.sizer.margin = 8; this.sizer.spacing = 8;
   this.sizer.add(left); this.sizer.add(right, 100);
   this.adjustToContents();

   this.onShow = function () { self.loadPreview(); };
}
DehaloDialog.prototype = new Dialog;

DehaloDialog.prototype.targetView = function () {
   var v = this.targetList.currentView;
   if (!v || v.isNull) throw new Error("Select a target image.");
   return v;
};

// Star list changed: old fits no longer match the stars.
DehaloDialog.prototype.starsChanged = function () {
   this.fits = null;
   HR.starGeometry(this.stars, this.opts);
   this.refreshStars();
   this.renderPreview(false);
   this.requestFit(false);
};

// Debounced detect/fit. The last fit stays on screen until the new one is ready.
DehaloDialog.prototype.requestFit = function (detect) {
   if (detect) this.pendingDetect = true;
   if (this.statusLabel) this.statusLabel.text = "Updating ...";
   this.fitTimer.stop();
   this.fitTimer.start();
};

DehaloDialog.prototype.runPipeline = function () {
   if (this.busy) { this.fitTimer.start(); return; }
   var v = this.targetList.currentView;
   if (!v || v.isNull) return;
   this.busy = true;
   try {
      this.ensureBinned();
      if (this.pendingDetect || this.stars.length == 0) { this.pendingDetect = false; this.detect(); }
      this.fit();
   } catch (e) {
      this.report(e);
   }
   this.busy = false;
};

DehaloDialog.prototype.refreshStars = function () {
   this.refreshing = true;
   this.starTree.clear();
   for (var i = 0; i < this.stars.length; ++i) {
      var s = this.stars[i], n = new TreeBoxNode(this.starTree);
      n.checkable = true; n.checked = s.enabled;
      n.setText(0, String(i + 1));
      n.setText(1, s.x.toFixed(1)); n.setText(2, s.y.toFixed(1)); n.setText(3, s.rcore.toFixed(1) + (s.det ? " (e)" : s.manual ? " (m)" : ""));
      n.setText(4, s.rFit ? s.rFit.toFixed(0) : "");
      if (this.fits) {
         var H = this.fits[0].halos[i];
         if (H) { n.setText(5, H.tail.a.toFixed(2)); n.setText(6, H.rCut.toFixed(0) + " px"); }
      }
      if (s === this.selStar) { this.starTree.currentNode = n; n.selected = true; }
   }
   this.refreshing = false;
   for (var c = 0; c < 7; ++c) this.starTree.adjustColumnWidthToContents(c);
   if (this.preview) this.preview.update();
};

DehaloDialog.prototype.ensureBinned = function () {
   var v = this.targetView();
   if (this.binned && this.binned.viewId == v.id && this.binned.dims.B == this.opts.bin) return this.binned;
   console.writeln("<end><cbr>" + HR_TITLE + ": binning " + v.id + " by " + this.opts.bin + " ...");
   var t = Date.now();
   this.binned = hrReadBinned(v.image, this.opts.bin);
   this.binned.viewId = v.id;
   this.disp = null;
   console.writeln(format("  %d x %d, %d channel(s), %.1f s", this.binned.dims.w, this.binned.dims.h, this.binned.nc, (Date.now() - t) / 1000));
   return this.binned;
};

// Show the target, then detect and fit in the background.
DehaloDialog.prototype.loadPreview = function () {
   try {
      var v = this.targetList.currentView;
      if (!v || v.isNull) return;
      this.statusLabel.text = "Reading image ..."; processEvents();
      this.ensureBinned();
      this.renderPreview(true);
      this.requestFit(this.stars.length == 0);
   } catch (e) { this.report(e); }
};

DehaloDialog.prototype.schedulePreview = function () {
   if (this.disp) this.disp.model = null;
   this.previewTimer.stop();
   this.previewTimer.start();
};

DehaloDialog.prototype.toggleBeforeAfter = function () {
   this.viewMode = this.viewMode == HR_VIEW_BEFORE ? HR_VIEW_AFTER : HR_VIEW_BEFORE;
   this.viewCombo.currentItem = this.viewMode;
   this.renderPreview(false);
};

// recomputeModel: rebuild the removed-halo arrays (reduction settings changed).
DehaloDialog.prototype.renderPreview = function (recomputeModel) {
   try {
      if (!this.binned) return;
      if (!this.disp) this.disp = hrMakeDisplay(this.binned);
      HR.starGeometry(this.stars, this.opts);
      if (this.fits && (recomputeModel || !this.disp.model)) this.disp.model = hrDisplayModel(this.disp, this.fits, this.stars, this.opts);
      if (!this.fits) this.disp.model = null;
      var mode = this.fits ? this.viewMode : HR_VIEW_BEFORE;
      var bmp = hrRenderBitmap(this.disp, mode, this.hardStretch, this.fits);
      this.preview.message = this.fits ? ["After", "Before", "Removed halo"][mode] + "   (Ctrl+click: before/after)" :
         "Before (fitting ...)";
      this.preview.setBitmap(bmp, this.disp);
   } catch (e) { this.report(e); }
};

// Select the next (d = 1) or previous (d = -1) star; a zoomed preview centres on it.
DehaloDialog.prototype.cycleStar = function (d) {
   var n = this.stars.length;
   if (n == 0) return;
   var i = this.stars.indexOf(this.selStar);
   i = i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n;
   var st = this.selStar = this.stars[i];
   this.refreshing = true;
   for (var k = 0; k < this.starTree.numberOfChildren; ++k) this.starTree.child(k).selected = false;
   var node = this.starTree.child(i);
   this.starTree.currentNode = node; node.selected = true;
   this.refreshing = false;
   this.statusLabel.text = format("Star %d selected%s.", i + 1, " (Alt+drag moves it, Ctrl+wheel or +/- resizes it)");
   this.preview.centerOn(st.x, st.y);
   this.preview.update();
};

// The selected star, or null with a note in the status line. A detected star that is
// edited becomes manual and keeps its detected values in det, so that detection does not
// add it again.
DehaloDialog.prototype.editableStar = function () {
   var st = this.selStar;
   if (!st || this.stars.indexOf(st) < 0) { this.statusLabel.text = "Select a star first: click its row in the table or press Space in the preview."; return null; }
   if (!st.manual) { st.manual = true; st.det = { x: st.x, y: st.y, rcore: st.rcore }; }
   return st;
};

// Multiply the core radius of the selected star by f.
DehaloDialog.prototype.resizeStar = function (f) {
   var st = this.editableStar();
   if (!st) return;
   st.rcore = Math.min(Math.max(st.rcore * f, 1), 500);
   HR.starGeometry(this.stars, this.opts);
   var i = this.stars.indexOf(st), node = this.starTree.child(i);
   if (node) node.setText(3, st.rcore.toFixed(1) + (st.det ? " (e)" : " (m)"));
   this.statusLabel.text = format("Star %d core r %.1f.", i + 1, st.rcore);
   this.preview.update();
   this.editTimer.stop(); this.editTimer.start();   // refit when the key or wheel stops
};

DehaloDialog.prototype.starMoved = function (st) {
   console.writeln(format(HR_TITLE + ": moved star to %.0f, %.0f.", st.x, st.y));
   this.starsChanged();
};

DehaloDialog.prototype.addStar = function (x, y) {
   var st = { x: x, y: y, rcore: this.addR.value, enabled: true, manual: true };
   this.stars.push(st);
   this.selStar = st;
   this.stars.sort(function (a, b) { return b.rcore - a.rcore; });
   console.writeln(format(HR_TITLE + ": added star at %.0f, %.0f (core r %.0f).", x, y, this.addR.value));
   this.starsChanged();
};

// Detection keeps manual and edited stars and the tick state of stars found again.
DehaloDialog.prototype.detect = function () {
   var b = this.ensureBinned(), v = this.targetView(), old = this.stars;
   var found = HR.detectStars(b.mx, b.dims.w, b.dims.h, b.dims.B, this.opts);
   for (var i = 0; i < found.length; ++i) hrRefineCentre(v.image, found[i], this.opts.satLevel);
   // An edited detected star (det) replaces the star that detection finds at its old place.
   var edited = old.filter(function (o) { return o.det; });
   found = found.filter(function (s) {
      return !edited.some(function (o) {
         var dx = o.det.x - s.x, dy = o.det.y - s.y, r = 3 * Math.max(o.det.rcore, s.rcore);
         return dx * dx + dy * dy < r * r;
      });
   });
   for (var i = 0; i < found.length; ++i) {
      var s = found[i];
      for (var j = 0; j < old.length; ++j) {
         var o = old[j], dx = o.x - s.x, dy = o.y - s.y, r = 3 * Math.max(o.rcore, s.rcore);
         if (!o.manual && dx * dx + dy * dy < r * r) s.enabled = o.enabled;
      }
   }
   var manual = old.filter(function (s) { return s.manual; });
   this.stars = found.concat(manual).sort(function (a, b) { return b.rcore - a.rcore; });
   this.fits = null;
   HR.starGeometry(this.stars, this.opts);
   console.writeln(HR_TITLE + ": " + found.length + " star(s) with saturated cores.");
   this.refreshStars();
};

DehaloDialog.prototype.fit = function () {
   if (this.stars.length == 0) {
      this.fits = null;
      this.statusLabel.text = "No stars found. Lower 'Min core r' or Shift+click a star in the preview.";
      this.renderPreview(false);
      return;
   }
   var b = this.ensureBinned();
   HR.starGeometry(this.stars, this.opts);
   var mask = hrMaskFor(this.maskList.currentView, b, this.invertMaskCheck.checked);
   var t = Date.now();
   this.statusLabel.text = "Fitting " + this.stars.length + " star(s) ..."; processEvents();
   var fits = hrFitAll(b, this.stars, this.opts, mask);
   this.fits = fits;
   this.statusLabel.text = format("Fitted %d star(s), %d channel(s) in %.1f s.", this.stars.length, b.nc, (Date.now() - t) / 1000);
   this.refreshStars();
   this.renderPreview(true);
};

DehaloDialog.prototype.apply = function () {
   try {
      if (!this.fits) { this.fitTimer.stop(); this.runPipeline(); }
      if (!this.fits) throw new Error("Nothing fitted: " + this.statusLabel.text);
      var v = this.targetView(), img = v.image, W = img.width, H = img.height, nc = img.numberOfChannels;
      HR.starGeometry(this.stars, this.opts);
      var t = Date.now(), replace = this.replaceCheck.checked;
      var modelWin = this.modelCheck.checked ? new ImageWindow(W, H, nc, 32, true, img.isColor, v.id + "_halomodel") : null;
      var mv = modelWin ? modelWin.mainView : null;
      if (mv) { mv.beginProcess(UndoFlag_NoSwapFile); mv.image.fill(0); }
      // The parameters go into the Script entry of the target's history.
      this.saveParameters();
      if (replace) {
         v.beginProcess(UndoFlag_DefaultMode);
         try { hrSubtractView(v, this.fits, this.stars, this.opts, mv); } finally { v.endProcess(); }
         console.writeln(format(HR_TITLE + ": replaced %s in %.1f s.", v.id, (Date.now() - t) / 1000));
      } else {
         var outWin = new ImageWindow(W, H, nc, 32, true, img.isColor, v.id + "_dehalo"), ov = outWin.mainView;
         ov.beginProcess(UndoFlag_NoSwapFile);
         try { ov.image.assign(img); hrSubtractView(ov, this.fits, this.stars, this.opts, mv); } finally { ov.endProcess(); }
         outWin.keywords = v.window.keywords;
         try { outWin.copyAstrometricSolution(v.window); } catch (e) {}
         ov.stf = v.stf;
         outWin.show();
         console.writeln(format(HR_TITLE + ": wrote %s in %.1f s.", ov.id, (Date.now() - t) / 1000));
      }
      if (mv) { mv.endProcess(); mv.stf = v.stf; modelWin.show(); }
      if (replace) {
         // The target changed: read it again and refit. The star list stays.
         this.binned = null; this.disp = null; this.fits = null;
         this.loadPreview();
         this.statusLabel.text = "Replaced " + v.id + " (Undo in PixInsight restores it). Preview and fit now show the new image.";
      }
      console.writeln(format("  outer %.2f, inner %.2f, protect %d px, transition %d px, mode %d",
         this.opts.outerAmount, this.opts.innerAmount, this.opts.protectRadius, this.opts.transition, this.opts.mode));
   } catch (e) { this.error(e); }
};

// All parameters back to HR.defaults(); target, mask and Invert stay. Stars are detected again.
DehaloDialog.prototype.resetDefaults = function () {
   if (this.busy) { this.statusLabel.text = "Busy, try Reset again in a moment."; return; }
   var o = HR.defaults(), rebin = o.bin != this.opts.bin;
   this.opts = o;
   this.setControls();
   this.modelCheck.checked = false;
   this.replaceCheck.checked = true; this.replaceCheck.onCheck(true);
   this.addR.setValue(10);
   this.viewMode = HR_VIEW_AFTER; this.viewCombo.currentItem = 0;
   this.hardStretch = false; this.stretchCombo.currentItem = 0;
   this.radiiCheck.checked = true; this.preview.showRadii = true;
   this.stars = []; this.fits = null; this.pendingDetect = true;
   if (rebin) { this.binned = null; this.disp = null; }
   this.refreshStars();
   this.loadPreview();
};

DehaloDialog.prototype.setControls = function () {
   var o = this.opts;
   this.binNC.setValue(o.bin); this.satNC.setValue(o.satLevel); this.minCoreNC.setValue(o.minCoreRadius); this.maxStarsNC.setValue(o.maxStars);
   this.modeCombo.currentItem = o.mode;
   this.innerNC.setValue(o.innerFactor); this.fitRNC.setValue(o.fitRadius); this.smoothNC.setValue(o.smoothing); this.iterNC.setValue(o.iterations);
   this.outerNC.setValue(o.outerAmount); this.innerAmtNC.setValue(o.innerAmount); this.coreNC.setValue(o.coreProtect); this.coreOpNC.setValue(o.coreOpacity); this.protectNC.setValue(o.protectRadius); this.transNC.setValue(o.transition);
   this.scaleCheck.checked = o.scaleRadii;
};

DehaloDialog.prototype.saveParameters = function () {
   var mv = this.maskList.currentView;
   hrSaveParameters(this.opts, this.stars, {
      maskId: mv && !mv.isNull ? mv.id : "", invert: this.invertMaskCheck.checked,
      replace: this.replaceCheck.checked, model: this.modelCheck.checked
   });
};

// Parameters of a Script icon or history entry opened as a dialog.
DehaloDialog.prototype.importParameters = function (p) {
   this.opts = p.opts;
   this.setControls();
   this.invertMaskCheck.checked = p.invert;
   this.replaceCheck.checked = p.replace; this.replaceCheck.onCheck(p.replace);
   this.modelCheck.checked = p.model;
   if (p.maskId) { var mv = View.viewById(p.maskId); if (mv && !mv.isNull) this.maskList.currentView = mv; }
   this.stars = p.stars;
   this.refreshStars();
};

// Installed documentation first (doc/scripts in the PixInsight folder), else the copy next to the script.
DehaloDialog.prototype.showDocumentation = function () {
   if (Dialog.browseScriptDocumentation(HR_TITLE)) return;
   if (!File.exists(HR_DOC_LOCAL)) {
      this.error(new Error("Documentation not found: " + HR_DOC_LOCAL));
      return;
   }
   (new HRDocDialog(HR_DOC_LOCAL)).execute();
};

function HRDocDialog(path) {
   this.__base__ = Dialog;
   this.__base__();
   this.windowTitle = HR_TITLE + " documentation";
   this.web = new WebView(this);
   this.web.loadContent(path);
   this.sizer = new VerticalSizer;
   this.sizer.add(this.web, 100);
   this.setScaledMinSize(900, 700);
}
HRDocDialog.prototype = new Dialog;

// Errors from automatic runs go to the status line and the console.
DehaloDialog.prototype.report = function (e) {
   console.criticalln(HR_TITLE + ": " + e.message);
   if (this.statusLabel) this.statusLabel.text = "<b>Error:</b> " + e.message;
};

DehaloDialog.prototype.error = function (e) {
   console.criticalln(HR_TITLE + ": " + e.message);
   (new MessageBox(e.message, HR_TITLE, StdIcon_Error, StdButton_Ok)).execute();
};

function main() {
   if (Parameters.isViewTarget) {
      // Script entry or icon executed on a view: no dialog.
      hrExecuteOn(Parameters.targetView, hrLoadParameters());
      return;
   }
   console.show();
   if (ImageWindow.windows.length == 0) {
      (new MessageBox("Open a linear image first.", HR_TITLE, StdIcon_Error, StdButton_Ok)).execute();
      return;
   }
   var d = new DehaloDialog();
   if (Parameters.isGlobalTarget) d.importParameters(hrLoadParameters());
   d.execute();
}

if (typeof HR_NO_MAIN === "undefined") main();
