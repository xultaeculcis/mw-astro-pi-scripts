# Troubleshooting

## "No stars found"

The detection finds only stars with a saturated core: pixels at or above **Saturation**, in a core at least
**Min core r** pixels wide.

- Move the cursor over the centre of a bright star and read the value. If the core is flat below 0.95, set the
  **Saturation** a little below that value. Integrated masters often saturate at 0.6 to 0.9
  ([M99](examples/m99.md)).
- Lower **Min core r** for images with small stars or a large pixel scale ([NGC 3077](examples/ngc-3077.md)).
- Lower **Binning** to 2 for small images.
- Add a star by hand: ++shift++ + click on it in the preview, then set its core radius with ++plus++ / ++minus++.

## A bright star is not detected

The core of the star is not saturated, or it is below the Saturation. Lower the Saturation, or add the star with
++shift++ + click. If **Max stars** is reached, the smallest cores are not used; increase Max stars.

## The detected centre is wrong

A stacking artefact, a bloom or a neighbour star merged into the core can move the centre. Select the star
(++space++ in the preview or its row in the table) and move it with ++alt++ + drag. Change its core radius with
++plus++ / ++minus++.

## Dark areas or a dark ring around the stars

The model removes more than the halo.

- Lower the **Outer reduction** or the **Inner reduction**.
- In a dense star field, lower **Max halo radius** and the **Outer reduction** (about 0.5)
  ([Arp 273](examples/arp-273.md)).
- A galaxy or a nebula inside the halo makes the profile too bright. Use an **Exclusion mask**
  ([Sh2-82](examples/sh2-82.md)).
- Small stars with a sharp edge: try **Core protection** 2 to 4 with **Core protection opacity** 0.3 to 0.7.
- Check with **Removed halo** and the **hard stretch** in the preview.

## A dark patch on one side of a star

The halo model is smooth and the same in all directions around the star. It cannot make a dark area on one side of
the star only. A one-sided patch, dark marks near the core or radial streaks are in the data: usually stacking and
normalization artifacts near saturated stars, which the halo hid before. Look at the original image with a hard
STF stretch to see them. Fix them in the integration or with retouching tools; changing the Dehalo settings does not
remove them. See [NGC 3310](examples/ngc-3310.md).

A dark ring that goes all around the star is different: that is over-subtraction (see above).

## Too little is removed near the star

Increase the **Inner reduction** (0.7 to 0.85) and lower the **Protect radius** (200 to 400 px)
([M99](examples/m99.md), [RCW 85](examples/rcw-85.md)).

## A large halo remains far from the star

Increase **Max halo radius**. The green circle in the preview must be well inside the visible halo, and the model
must reach the edge of the halo.

## The preview of an RGB image has a strong colour cast

The preview stretch is linked and the background levels of the channels are different. Untick **Linked**, or run
BackgroundNeutralization first ([Preparing images](preparing-images.md#linked-and-unlinked-preview-stretch)).

## The keys do nothing in the preview

Move the mouse over the preview. The preview receives the keys only when it has the keyboard focus.

## Alt + wheel does not resize the star

Qt changes Alt + wheel to a horizontal wheel on some systems. Use ++ctrl++ + wheel or ++plus++ / ++minus++.

## A replayed history entry gives an error about the mask

The run used an exclusion mask. Open the mask image with the same identifier before you drag the history entry onto
the image.
