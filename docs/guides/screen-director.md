# The screen director

Friend's assistant lays out its own screen. It says what each thing is for; the system picks the place for the screen you are using (desktop, tablet or phone) and keeps the safe parts free.

## What you will notice

- **One clear thing to look at.** The main answer is the focus, in the middle. A few related things sit beside it. Nothing covers the captions, the clock, your pinned widgets, your panels or the live instruments.
- **Nothing is crowded.** When something new comes up, what was shown becomes a small chip along the top (a name, and a value when it has one, like `Temp 24 C`). Tap a chip to bring it back. The oldest card is put away first when a screen is full.
- **Cards tidy themselves.** A card the assistant put beside the main thing is put away after 40 seconds (never before there was time to read it: about 15 letters per second plus a second and a half). Cards you moved by hand, pinned widgets, the main thing and urgent things are never put away by the assistant.
- **Urgent means alone.** An error or something you must decide is shown by itself, in alert style. What was on the screen becomes chips.
- **It follows the screen.** Turn the phone, resize the window or open Friend on another device and the shown things are laid out again for that screen. Nothing is lost: what does not fit becomes a chip and comes back when there is room.

| Screen | Focus | Beside | Chips |
|---|---|---|---|
| Desktop | wide, in the middle | up to 3 | up to 7 |
| Tablet | most of the width | up to 2 | up to 5 |
| Phone | full width under the orb | one at a time | up to 5, a scrolling row |

## Settings

Settings, Widgets, **Screen tidy** (owner only, the assistant cannot change them):

- **Tidy the screen by itself** (on). Off keeps cards until they are replaced or dismissed.
- **Put cards away after** (40 seconds; 0 keeps them).
- **Most chips in the strip** (by screen, or 3 to 12).

## What the assistant uses

- `screen.compose` with five roles: `focus`, `beside`, `glance` (a chip), `note` (floats on top, leaves by itself) and `alert`. Mode `replace` for a new topic, `add` for more of the same.
- The bundled **Screen design** skill (installed once on the first start; remove it in Plugins if you do not want it and it stays removed). It teaches the principles and gives a recipe for the common requests.
- `stage.check`, which now also says in words when the screen is crowded, has no focus or has a small focus.

The older `stage.show` with regions still works.
