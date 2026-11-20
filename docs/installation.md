# Installation

The scripts need PixInsight 1.9 or newer. They are tested with PixInsight 1.9.6 on Linux.

## 1. Get the scripts

=== "git"

    ```
    git clone https://github.com/xultaeculcis/mw-astro-pi-scripts.git
    ```

=== "ZIP download"

    On the [GitHub page](https://github.com/xultaeculcis/mw-astro-pi-scripts), click **Code > Download ZIP** and
    extract the archive to a folder that you keep, for example `~/pixinsight/mw-astro-pi-scripts`.

Keep the folder in the same place after you install. PixInsight remembers the path of each script, and the history
entries of processed images point to it.

## 2. Add the scripts to PixInsight

1. In PixInsight, select **Script > Feature Scripts...**
2. Click **Add** and select the folder from step 1 (the folder that contains `Dehalo/`).
3. Click **Done**.

The scripts are now in the **Script** menu. Dehalo is at **Script > Utilities > Dehalo**.

## 3. Install the documentation (optional)

Each script has a reference page in the PixInsight documentation style. It opens with the documentation button
(page icon) in the script dialog, and it shows in the Process Explorer. To install it, copy the script's
`doc/scripts/<Script>` folder to the `doc/scripts` folder of your PixInsight installation:

=== "Linux"

    ```
    sudo cp -r Dehalo/doc/scripts/Dehalo /opt/PixInsight/doc/scripts/
    ```

=== "Windows"

    Copy `Dehalo\doc\scripts\Dehalo` to `C:\Program Files\PixInsight\doc\scripts\` (administrator rights are
    necessary).

=== "macOS"

    Copy `Dehalo/doc/scripts/Dehalo` to the `doc/scripts` folder of your PixInsight installation, usually
    `/Applications/PixInsight/doc/scripts/`.

Copy the folder again after each update.

## Update

```
cd mw-astro-pi-scripts
git pull
```

If you use the ZIP download, extract the new archive into the same folder. If a script is missing from the menu
after an update, select **Script > Feature Scripts...**, click **Regenerate**, then **Done**.

## Uninstall

Select **Script > Feature Scripts...**, select the folder, click **Remove**, then **Done**. Then delete the folder.
