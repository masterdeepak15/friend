# Screen design

Use this before you draw a screen you have not drawn before. The owner reads your answer in your voice; the screen is the proof, not a second copy of what you said. A good screen always has something clear to look at.

## The five ideas

1. **Answer first.** Say it, then show only what backs it up. A screen full of everything you know is a worse answer than one clear picture.
2. **One focus.** Exactly one thing is the main thing: the thing the owner asked to see. It gets the most room, in the middle. Everything else is smaller than it.
3. **Few things.** A focus and two or three things beside it is a lot. Anything more belongs in a chip, not a card.
4. **Put away what is done.** When the topic changes, the old things become small chips along the top (nothing is lost, one tap brings them back). When a task is finished, clear what you showed for it. The screen goes back to calm.
5. **Urgent is alone.** An error or something the owner must act on is shown by itself, in alert style. Do not decorate it with other cards.

## The tool: screen.compose

You say what each thing is for. The system picks the place for this screen. You never give coordinates.

| role | use it for | what happens |
|---|---|---|
| `focus` | the one thing the owner asked to see | main place, biggest. A big thing (a page, a chart, a long table) takes the middle and the orb steps aside |
| `beside` | supports the focus (a related number, a short list) | a side place; only a few fit, the oldest is put away as a chip |
| `glance` | a small value worth keeping in view (24 C, 3 new) | a chip along the top; give a short `label` |
| `note` | a short passing remark or confirmation | floats on top and leaves by itself (`ttl` 15 to 60 seconds) |
| `alert` | urgent: an error, a warning, a decision | shown alone; what was there becomes chips |

`mode`: **replace** (the default) is a new topic: what was shown is put away as chips. **add** is more of the same topic. Use the same `id` again to refresh a card (a gauge with a new value) instead of drawing a second one. Read the result: it tells you where everything went and what was put away and why, so you can learn from it.

## For each screen

- **Desktop:** a focus in the middle, up to three cards beside it, chips along the top. Use `beside` for what really helps, not to fill space.
- **Tablet:** a focus and up to two cards beside it. Keep text large and short.
- **Phone:** one card at a time under the orb; everything else is a chip. Prefer a stat, a gauge or a short list over a wide chart or table. The request's `screen:` line says which one this is; if it changes (the owner turns the phone), the screen is laid out again by itself.

## Recipes

The weather and the news: the weather is what was asked first, so it is the focus; the news is beside it.

```json
{ "items": [
  { "id": "weather", "type": "stat", "props": { "label": "Pune", "value": 24, "unit": "C" }, "role": "focus" },
  { "id": "news", "type": "list", "props": { "title": "News", "items": ["First headline", "Second headline", "Third headline"] }, "role": "beside" }
] }
```

Today's schedule: one timeline is the focus. Nothing else.

```json
{ "items": [
  { "id": "today", "type": "timeline", "props": { "title": "Today", "items": [{ "time": "09:30", "text": "Stand-up" }, { "time": "14:00", "text": "Review" }] }, "role": "focus" }
] }
```

An error the owner must see: alone, alert style.

```json
{ "items": [
  { "id": "oops", "type": "card", "props": { "title": "Backup failed", "text": "The disk is full. Free some space and I will try again." }, "role": "alert" }
] }
```

A chart with a table: the chart is the focus, the table's top rows are beside it. If the table is long, show the first rows and say the rest in your voice.

```json
{ "items": [
  { "id": "sales", "type": "chart", "props": { "title": "Sales", "kind": "line", "points": [3, 5, 4, 8, 9] }, "role": "focus" },
  { "id": "top", "type": "table", "props": { "title": "Top 3", "columns": ["Item", "Units"], "rows": [["A", 9], ["B", 7], ["C", 4]] }, "role": "beside" }
] }
```

Compare two things: two stats side by side, the more important one as the focus.

```json
{ "items": [
  { "id": "now", "type": "stat", "props": { "label": "This month", "value": 120, "unit": "k" }, "role": "focus" },
  { "id": "before", "type": "stat", "props": { "label": "Last month", "value": 98, "unit": "k" }, "role": "beside" }
] }
```

A small value to keep an eye on while you do something else: a chip, mode add.

```json
{ "mode": "add", "items": [
  { "id": "temp", "type": "stat", "props": { "label": "Temp", "value": 24, "unit": "C" }, "role": "glance", "label": "Temp" }
] }
```

A passing confirmation while something is on the screen: a note. It does not move anything.

```json
{ "mode": "add", "items": [
  { "id": "saved", "type": "card", "props": { "text": "Saved to your notes." }, "role": "note", "ttl": 15 }
] }
```

A long explanation: say it, show a short markdown card as the focus with only the key points.

## After you draw

If you drew more than two things, call `stage.check` once. It says in words what is cut off, covered or too crowded; fix exactly what it names and stop. When the owner has what they need, take away what you showed for the task (`stage.hide`, or `stage.clear`; pinned widgets stay). Never move, hide or unpin what the owner pinned or moved by hand.
