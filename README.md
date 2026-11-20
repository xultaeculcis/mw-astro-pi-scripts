# mw-astro-pi-scripts

PixInsight scripts for astrophotography processing. Each script is in its own folder with a README
and its documentation.

| Script | Menu | What it does |
|---|---|---|
| [Dehalo](Dehalo/) | Script > Utilities > Dehalo | Models the wide halos of bright stars on linear images and subtracts them. |

## Install

1. Clone the repository:
   ```
   git clone https://github.com/xultaeculcis/mw-astro-pi-scripts.git
   ```
2. In PixInsight: **Script > Feature Scripts > Add**, select the cloned folder, then **Done**. The
   scripts show in the Script menu.
3. Optional, the documentation in the Process Explorer and the script's doc button: copy the
   script's `doc/scripts/<Script>` folder to `<PixInsight>/doc/scripts/`. For example on Linux:
   ```
   sudo cp -r Dehalo/doc/scripts/Dehalo /opt/PixInsight/doc/scripts/
   ```

After a `git pull`, run **Script > Feature Scripts > Regenerate** if a script's menu entry changed.

Tested with PixInsight 1.9.6 on Linux.
