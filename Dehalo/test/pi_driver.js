// Headless PixInsight test of the dialog code paths (no execute()).
// PixInsight.sh -n --automation-mode -r=pi_driver.js --force-exit
// DATA must hold raw/L.fit and the masks folder with the XISF masks named below. Edit DATA before use.
// The results go to OUT (log.txt, FITS files and dialog screenshots).
var HR_NO_MAIN = true;
#include "../Dehalo.js"
var DATA = File.homeDirectory + "/dehalo-data";
var OUT = File.systemTempDirectory + "/dehalo-test";
if (!File.directoryExists(OUT)) File.createDirectory(OUT, true);
var LOG = [];
function log(s) { console.writeln(s); LOG.push(String(s)); File.writeTextFile(OUT + "/log.txt", LOG.join("\n")); }
function save(win, name) { win.saveAs(OUT + "/" + name + ".fits", false, false, false, false); }
function shot(d, name) {
   try { processEvents(); var b = d.render(); b.save(OUT + "/" + name + "_dialog.png"); log("dialog shot " + b.width + "x" + b.height); }
   catch (e) { log("dialog render failed: " + e); }
}
try {
   var t0 = Date.now();
   var w = ImageWindow.open(DATA + "/raw/L.fit")[0]; w.show();
   var ids = [];
   ["galaxy_protection_mask", "tidal_loops_extent_mask", "star_streams_extent_mask"].forEach(function (n) {
      var mw = ImageWindow.open(DATA + "/masks/" + n + ".xisf")[0]; mw.show(); ids.push(mw.mainView.id);
   });
   var pm = new PixelMath;
   pm.expression = "max(1-" + ids[0] + "," + ids[1] + "," + ids[2] + ")"; pm.useSingleExpression = true; pm.createNewImage = false;
   pm.executeOn(ImageWindow.windowById(ids[0]).mainView);
   var mask = ImageWindow.windowById(ids[0]);
   w.bringToFront();
   var d = new DehaloDialog();
   d.error = function (e) { log("ERROR " + e.message + "\n" + e.stack); };
   d.targetList.currentView = w.mainView;
   d.maskList.currentView = mask.mainView;
   try { d.show(); d.resize(1500, 900); processEvents(); } catch (e) { log("show failed " + e); }
   d.loadPreview();                 // reads the image, schedules detect + fit
   shot(d, "0_loaded");
   d.runPipeline();                 // what the timer runs
   log("status: " + d.statusLabel.text + " | stars " + d.stars.length + " | fitted " + (d.fits != null));
   shot(d, "1_fitted");
   var t = Date.now(); for (var i = 0; i < 5; ++i) { d.opts.outerAmount = 0.5 + 0.1 * i; d.renderPreview(true); } log("5 live renders ms " + (Date.now() - t));
   d.opts.outerAmount = 1.0; d.renderPreview(true);
   // untick star 2 through the tree callback
   var n2 = d.starTree.child(1); n2.checked = false; d.starTree.onNodeUpdated(n2, 0);
   log("star 2 enabled after untick: " + d.stars[1].enabled);
   // remove rows 7 and 8
   d.starTree.child(6).selected = true; d.starTree.child(7).selected = true;
   d.removeButton.onClick();
   log("after remove: stars " + d.stars.length + ", fitted " + (d.fits != null) + ", status " + d.statusLabel.text);
   d.runPipeline();
   log("after refit: " + d.statusLabel.text);
   d.toggleBeforeAfter(); log("view after Ctrl+click: " + d.viewMode); shot(d, "2_before");
   d.toggleBeforeAfter(); log("view after 2nd Ctrl+click: " + d.viewMode);
   d.addStar(3000, 5000); log("stars after Shift+click add: " + d.stars.length + " fitted " + (d.fits != null));
   d.runPipeline(); log("after add refit: " + d.statusLabel.text);
   shot(d, "3_final");
   function geo(c) { var p = c.globalPosition ? c.globalPosition : c.position; return p.y + ".." + (p.y + c.height); }
   log("geometry y: tree " + geo(d.starTree) + ", addR " + geo(d.addR) + ", removeButton " + geo(d.removeButton));
   // Replace target through PixelMath
   var px0 = w.mainView.image.sample(3000, 5000), nWin0 = ImageWindow.windows.length;
   var h0 = w.mainView.processing.length;
   d.replaceCheck.checked = true; d.replaceCheck.onCheck(true);
   d.apply();
   log("replace: windows " + nWin0 + " -> " + ImageWindow.windows.length + ", history " + h0 + " -> " + w.mainView.processing.length +
       ", last step " + (w.mainView.processing.length ? w.mainView.processing.at(w.mainView.processing.length - 1).processId() : "-"));
   log("pixel (3000,5000) " + px0 + " -> " + w.mainView.image.sample(3000, 5000) + ", status " + d.statusLabel.text);
   d.runPipeline(); log("refit after replace: " + d.statusLabel.text);
   shot(d, "4_replaced");
   w.undo(); log("after undo pixel " + w.mainView.image.sample(3000, 5000) + " history " + w.mainView.processing.length);
   // Reset to defaults
   d.outerNC.setValue(0.4); d.opts.outerAmount = 0.4; d.opts.minCoreRadius = 12; d.minCoreNC.setValue(12); d.modelCheck.checked = true;
   d.resetDefaults(); d.runPipeline();
   var def = HR.defaults(), same = true; for (var k in def) if (def[k] !== d.opts[k]) { same = false; log("  differs " + k); }
   log("reset: opts default " + same + ", outerNC " + d.outerNC.value + ", minCore " + d.minCoreNC.value + ", model " + d.modelCheck.checked +
       ", replace " + d.replaceCheck.checked + ", stars " + d.stars.length + ", status " + d.statusLabel.text);
   shot(d, "5_reset");
   // Documentation
   log("doc local " + HR_DOC_LOCAL + " exists " + File.exists(HR_DOC_LOCAL));
   var tb = Date.now(); log("browseScriptDocumentation: " + Dialog.browseScriptDocumentation(HR_TITLE) + " in ms " + (Date.now() - tb));
   var dd = new HRDocDialog(HR_DOC_LOCAL); dd.show(); dd.resize(1000, 800);
   var tw = Date.now(); while (Date.now() - tw < 4000) processEvents();
   shot(dd, "6_doc"); dd.ok();
   log("total ms " + (Date.now() - t0));
   log("DONE");
} catch (e) { log("FATAL " + e + "\n" + e.stack); }
