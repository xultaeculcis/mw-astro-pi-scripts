# Dehalo

PixInsight script (PJSR) that models wide halos of bright stars and subtracts them from LINEAR data.
It keeps a natural, light halo near each star and removes the faint wings on the outskirts, where
they cover galaxies, tidal tails and IFN.

## Install

`Script > Feature Scripts... > Add` and pick this folder, or run it once from
`Script > Execute Script File...`. It shows up as `Script > Utilities > Dehalo`. Do not confuse it with the built-in `StarHaloReducer`, which needs a preview and works on stretched images.

## Use

1. Open a linear master (L, R, G or B) or a linear RGB and make it the active window. Run the script
   before gradient removal, BlurXTerminator and the stretch.
2. The script reads the image, detects stars with saturated cores and fits them on its own. Any change to
   the image, mask, detection or model settings refits after a short pause. The last result stays on
   screen until the new one is ready.
3. Optional: pick an **Exclusion mask** where white means a structure to keep out of the fit (galaxy,
   tidal loops, streams). If the structure is black (protection masks), tick **Invert**.
   The script refuses a mask that covers more than 80% of the image.
4. Star table: **untick** a star to leave its halo in the image. It stays in the fit, so the other stars'
   models still account for it. **Remove selected rows** (select rows with click, Ctrl+click,
   Shift+click) takes false detections out of the model. **Shift+click** in the preview adds a star
   (core radius from "Shift+click core r"). **Space** (Shift+Space back) in the preview selects the
   next star (cyan circle); **Alt+drag** moves the selected star, **+/-** (hold for continuous change) or **Ctrl+wheel**
   changes its core radius. Zoom out below fit to place a star outside the frame whose halo reaches in. An edited
   detected star is marked (e) and stays when detection runs again. Lower **Min core r** if a halo star is missing (RGB
   masters saturate less than L).
5. The preview (right side) updates live with the reduction sliders. **Ctrl+click** switches between
   before and after. The combo also offers "Removed halo". Normal or hard stretch (for faint halo and
   IFN). **Linked** stretches all colour channels together (keeps the colour balance); unticked, each
   channel is stretched on its own. Wheel zooms, drag pans, double-click fits the view. Circles: yellow = protect radius,
   green = full outer reduction, grey = unticked star.
6. **Apply** (bottom left) works at full resolution. With **Replace target image** ticked (default) it
   writes the result into the target. The target gets one Dehalo (Script) history entry with all
   parameters and the star list, and Undo restores it. Negative values are set to 0. Drag the history
   entry onto another image (for example the R, G, B masters of the same field) to run it again
   without the dialog. After the replace the script reads the target again and refits, so a second
   Apply only removes the residual halo. Unticked, Apply writes a new `<id>_dehalo` image and the
   target is not changed. `<id>_halomodel` is created in both modes if ticked.
7. **Core protection** (x core r, default 0 = off): no subtraction inside this radius, full reduction from
   twice the radius. This keeps the star edge without a step or dark ring.
   **Core protection opacity** (0..1, default 0) sets how much of that zone is protected; 0.3-0.7
   gives a weaker glow around small stars that fades out. Both are off by default; the protection
   works only when both are above 0.
8. Bottom left: the triangle (New Instance) makes a process icon with the parameters and stars, the
   page icon opens the documentation, the reset icon sets all parameters to their defaults and detects
   the stars again. Manual stars are removed. Target, mask and Invert stay.

## Documentation

`doc/scripts/Dehalo/Dehalo.html` is a PixInsight reference page (pidoc style), with the full theory: image
model, detection, profile statistics, fits, joint backfitting, sky plane and reduction weight, with formulas.
It is generated, do not edit it by hand. Edit `doc/src/Dehalo.html` (LaTeX math in `$...$` / `$$...$$`) and run
`uv run --with latex2mathml doc/build_doc.py`. The formulas become MathML, which the PixInsight browser shows. The documentation button
first asks PixInsight for the installed page. If PixInsight does not have it, the script shows this local copy in
its own window. `doc/pidoc` is a symlink to `/opt/PixInsight/doc/pidoc` for the styles. To install the page
into PixInsight (repeat after a PixInsight reinstall):

    sudo cp -r doc/scripts/Dehalo /opt/PixInsight/doc/scripts/

## Settings

| Setting | Meaning |
|---|---|
| Approach: Empirical | Measured azimuthal profile, smoothed. Beyond the radius where it falls into the noise it continues as a power law. Default. |
| Approach: Smooth power law | One `A*r^-a` fitted on the outskirts. It never goes above the measured profile. It removes less near the star. |
| Outer reduction | Fraction of the halo removed far from the star (1 = all of it). |
| Inner reduction | Fraction removed close to the star. Lower values keep more natural halo. |
| Protect radius / Transition width | The reduction ramps from inner to outer between `protect` and `protect + transition` (px, brightest star). |
| Scale radii with star brightness | Radii scale with each star's core radius. The halo extent is about proportional to it. |
| Max halo radius | Fit radius of the brightest star. Other stars scale. The model tapers to zero over a further 50%. |

The sky plane is used only for the fit. It is never subtracted, so you still remove the gradient later.

## Limits

- Only azimuthal: radial streaks and off-centre reflection ghosts stay. Keep the inner reduction low so
  they stay inside a natural halo.
- Stars without a saturated core must be added by hand.

## Tests

- `test/engine_test.js`: runs the engine (code between `ENGINE-BEGIN` and `ENGINE-END`) in node on
  binned float32 data.
- `test/pi_driver.js`: headless PixInsight run of the dialog code paths:
  `PixInsight.sh -n --automation-mode -r=test/pi_driver.js --force-exit`.
  Set `DATA` in the file to a folder with `raw/L.fit` and the masks. The results go to
  `<temp>/dehalo-test`.
