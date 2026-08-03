# AutoTune build.yaml references

- `build.bash.yaml` — local run on the **bash** environment via
  `space://steps/autotune` (`BACKEND: mlx`). Set `FM_TUNE_ROOT` to your fm-tune
  checkout. The inline `autotune-config` is materialized by the step's
  `command.sh`.
- `build.k8s.yaml` — **production** run using the shipped `space://steps/custom_code`.
  The same inline `autotune-config` block is written to `/tmp/autotunex.yaml` by
  `config.gb.files_to_create`, so no bespoke k8s step is needed.

Both are structural references; neither is submitted by the plan.
