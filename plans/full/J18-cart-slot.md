# J18 — Cart panel defaults to the right (secondary) slot

- **Source plan:** `plans/ui-cleanup-plan.md` (Panels — "Cart panel defaults to the right (secondary) slot")
- **Wave:** 0
- **Depends on:** J01 (shares `ui/topbar.js` with the spine work)
- **Locks files:** network_toy/app/src/ui/topbar.js
- **Parallel-safe with:** any job not locking topbar.js. NOT with: J01/J05/J09/J26 (topbar.js)
- **Order constraint:** after J01 on topbar.js. May pair with J10 (resizing) so the cart table reads OK in the narrower right rail.

## Goal
The cart currently opens in the wide `bottom` slot because the cart table is wide. Move the default so the cart opens in the right-hand `secondary` slot instead, and confirm the table still reads acceptably in the narrower right rail.

## Changes
- `ui/topbar.js` — `openCartPanel` (~L158): change `addTab("bottom", "cart", {})` to open in the `secondary` slot (`addTab("secondary", "cart", {})`). This is the only line that needs to change.

## Verification
- In a real browser (Playwright / webapp-testing), click the cart button (top-right) and observe the cart tab appears in the right-hand `secondary` slot, not the bottom slot.
- Add several papers to the cart and confirm the cart table columns are readable in the narrower right rail (no critical columns clipped/overflowing). Flag to the user if the table needs J10 resizing to be usable.
