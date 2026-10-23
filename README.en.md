# Task Plugin Scout

**English** | [中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that answers one question
before work starts: **which plugins already available to this profile would make the task at hand easier?**

It registers one model-facing tool, `plugin_scout`, plus a short system-prompt section that reminds the agent
to use it. Given a one-line task description it ranks this profile's plugins — **already active**, **installed
but disabled**, and **installable from the configured market indexes** — and returns the exact next step for
each candidate (enable, install, or nothing).

- Package: `dsh-task-plugin-scout` · loader row: `dsh-task-plugin-scout`
- Host-only bundle: no dependencies, no build step, plain ESM JavaScript
- Changes nobody's state by itself: it only *recommends*; enabling or installing still goes through
  `plugin_manager` and the user's approval

## What you get

| Part | Name | Purpose |
| --- | --- | --- |
| Model tool | `plugin_scout` | Ranks plugin candidates for a task and returns each one's next step |
| Prompt section | `plugin-scout:discovery` (order 700) | Tells the agent to scout before starting non-trivial work |

Example result (numbers are illustrative; each run reports its own `Coverage`):

```
Plugin Scout · task: 把开会录音转成文字纪要 (voice, transcription)
Coverage: 3 of the listed candidates need an action to take effect · 48 bundles · 214 plugin rows · 12 market entries · https://example.com/index.json: 12 of 1234

1. 语音输入 [disabled, score 10] — bundle `@deepseek-ai/dsh-experimental-voice-input-bundle`
   在本机使用 SenseVoice 转写录音，首次使用需安装依赖。
   matched: voice
   next: plugin_manager { action: "set_bundle", target: "@deepseek-ai/dsh-experimental-voice-input-bundle", enabled: true }
```

`state` is one of:

| State | Meaning | Next step |
| --- | --- | --- |
| `active` | Already running in this profile | none |
| `disabled` | Installed but switched off (including shipped opt-in bundles) | `set_bundle` / `set_plugin` |
| `available` | Not installed; offered by the Official catalog or a market index | `install_bundle` |

## Install

DSH must have `plugin-manager` (standard in shipped profiles). Use the `plugin_manager` tool:

```jsonc
// from Git (after this repository is public)
{ "action": "install_bundle", "target": "git+https://github.com/crane-you/dsh-task-plugin-scout.git" }

// from a local checkout (absolute path to the package directory)
{ "action": "install_bundle", "target": "D:\\path\\to\\task-plugin-scout" }
```

Activation is reported as `application: applied`. Confirm with `cordis_inspect_query`
(`Tool.listTools` should list `plugin_scout`) rather than by reading logs.

## Tool reference

| Argument | Type | Default | Meaning |
| --- | --- | --- | --- |
| `task` | string, **required** | — | What the user asked for, in one or two lines. Keep the user's own words and add English capability keywords when the task is not in English, because most plugin metadata is English. |
| `limit` | integer | `5` | How many candidates to return (1–12). |
| `useMarket` | boolean | `true` | Include the configured market indexes. Set `false` for a local, offline answer. |
| `includeActive` | boolean | `true` | Whether already-active plugins may be listed. Set `false` to see only candidates that need an action. |

## How ranking works

1. **Capability concepts** — about 35 bilingual concept groups (voice, translation, spreadsheet, image,
   parallel work, scheduling, notifications, …). When the task hits a concept *and* a candidate's
   name/title/description/keywords hits the same concept, it scores +6. This is what lets a Chinese task find
   an English-described plugin, and vice versa.
2. **Literal overlap** — the task is tokenized (Latin words, CJK bigrams); a token in the plugin name scores
   +3, in its title +2, in its description or keywords +1.
3. **Tie-break by state** — `disabled` → `available` → `active`, so actionable candidates come first.
4. **Matching is boundary-aware** — ASCII concept forms must start at a word boundary, so `transcription`
   never triggers `script` and `password` never triggers `word`; CJK forms match as substrings.

## Configuration

Optional fields on the plugin row's `config` (a profile `cordis.patch.yml` override):

| Field | Default | Meaning |
| --- | --- | --- |
| `promptHint` | `true` | Whether to register the system-prompt section |
| `hintText` | built-in text | Replaces the whole prompt section |
| `limit` | `5` | Default for the `limit` argument |
| `useMarket` | `true` | Default for the `useMarket` argument |

The plugin declares no `Config` schema, so the object is read as-is and a misspelled field is not validated.

## Known limits

- **Row-level candidates (`kind: plugin`) describe the profile patch layer.** An agent preset can already
  mount the same row, in which case the capability is effectively present; the tool prints that caveat
  whenever it lists a disabled row. Bundle-level candidates are not affected.
- **Market results need a configured index.** The service mounts with the market bundle, but ships with no
  index source; until one is added the tool reports `market: no index configured` and falls back to
  local-only results.
- **Market text is third-party content**, not instructions, and indexes are unsigned — the installed manifest
  decides what actually installs.
- **The tool never enables or installs anything** on its own; those steps keep their own approval.

## Privacy

- **Nothing is collected or reported.** No telemetry, no analytics, no files written, no memory kept outside
  the session. All work happens in the Host process against in-memory inventories.
- **The task description never leaves the machine.** The only outbound path is the plugin market: the Host
  downloads the index documents you configured (a plain GET), and `task` is used **locally** to filter the
  already-downloaded document — the market service caches a document per URL, shares one fetch between
  concurrent readers of that URL, and never puts query text into a request. Set `useMarket: false` for a
  fully offline run.
- **What enters the session log**: matched plugin names, titles and descriptions, plus the local inventory
  counts. They are recorded with the tool result in your own session log (for replay and fork); sharing that
  transcript would disclose your installed-plugin list. `includeActive: false` narrows the result to
  candidates that need an action.
- **Market text is third-party content** and indexes are unsigned; it is presented as a candidate only, and
  the installed manifest decides what actually installs.

## Development

`test/harness.mjs` mounts the bundle on a fake context with fixture inventories and exercises ranking,
argument handling, error handling, and the config path — no DSH required:

```bash
node test/harness.mjs
```

## License

[MIT](LICENSE)