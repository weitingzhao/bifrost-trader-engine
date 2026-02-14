# Windows helpers

Scripts for running the project on Windows when Python/pip are not on PATH.

- **install.ps1** – PowerShell (tries `py`, `python`, `python3`, then common install paths).
- **install.cmd** – Batch (no execution policy; use if PowerShell scripts are blocked).

Run from **project root**:

```powershell
.\os\win\install.cmd
```

Or (if execution policy allows):

```powershell
.\os\win\install.ps1
```

Or with bypass:

```powershell
powershell -ExecutionPolicy Bypass -File .\os\win\install.ps1
```

Both scripts change to the project root and run `pip install -r requirements.txt` there.
