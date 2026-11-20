// Run the Dehalo engine in node on binned float32 data.
// usage: node engine_test.js <dir> <channel> [jsonOpts]
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'Dehalo.js'), 'utf8');
const eng = src.split('// ENGINE-BEGIN')[1].split('// ENGINE-END')[0];
const HR = new Function(eng + '; return HR;')();
const [dir, ch, extra] = process.argv.slice(2);
const dims = { W: 11405, H: 8388, B: 4, w: 2851, h: 2097 };
const rd = f => new Float32Array(fs.readFileSync(path.join(dir, f)).buffer.slice(0));
const M = rd(ch + '_mean.f32'), mx = rd('L_mx.f32');
const useMask = !(extra && JSON.parse(extra).noMask);
const mask = useMask ? rd('galmask.f32') : null;
const opts = Object.assign(HR.defaults(), extra ? JSON.parse(extra) : {});
let t = Date.now();
const stars = HR.detectStars(mx, dims.w, dims.h, dims.B, opts);
HR.starGeometry(stars, opts);
console.log('detect', Date.now() - t, 'ms');
stars.forEach((s, i) => console.log(i, s.x.toFixed(0), s.y.toFixed(0), 'rcore', s.rcore.toFixed(1), 'rFit', s.rFit.toFixed(0)));
t = Date.now();
const fit = HR.fitChannel(M, mx, mask, dims, stars, opts, (it, ctx) => console.log('iter', it, ctx.plane));
console.log('fit', Date.now() - t, 'ms');
fit.halos.forEach((H, k) => console.log(k, 'sky', H.sky.toExponential(3), 'rCut', H.rCut.toFixed(0), 'tail a', H.tail.a.toFixed(2),
  'h@300', HR.evalHalo(H, 300).toExponential(2), 'h@1000', HR.evalHalo(H, 1000).toExponential(2), 'h@2000', HR.evalHalo(H, 2000).toExponential(2)));
const out = HR.renderBinned(M, dims, stars, HR.renderLuts(fit, stars, opts));
fs.writeFileSync(path.join(dir, ch + '_out.f32'), Buffer.from(out.buffer));
fs.writeFileSync(path.join(dir, ch + '_fit.json'), JSON.stringify({ plane: fit.plane, stars }));
// full-res row subtraction smoke test (one block through the star)
const s0 = stars[0], buf = new Float32Array(dims.W * 4);
HR.subtractRows(buf, dims.W, Math.round(s0.y) + 500, 4, stars, HR.renderLuts(fit, stars, opts), -1);
console.log('row model @ y+500 near x:', buf[Math.round(s0.x)].toExponential(3), 'expected ~', HR.evalHalo(fit.halos[0], 500).toExponential(3), '* w');
