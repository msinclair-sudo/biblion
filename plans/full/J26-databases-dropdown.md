# J26 — "Databases" dropdown menu (top-left)

- **Source plan:** `plans/ui-cleanup-plan.md` (Data panel / shell — "Databases" dropdown menu (top-left))
- **Wave:** 3
- **Depends on:** J05 (the dropdown wires into the dataset / `serve.py` flow and shares `ui/topbar.js`)
- **Locks files:** network_toy/app/src/ui/topbar.js (add the dropdown at top-left; the cart button `renderCart` ~L132 is the existing top-right precedent), plus new modals for connect / make / manage (network_toy/app/src/ui/modals/), and the data-source flow it wires into (network_toy/app/src/datasource/sqlite.js + real.js — read/coordinate)
- **Parallel-safe with:** any job not touching topbar.js. NOT with: J01/J05/J09/J18 (topbar.js)
- **Order constraint:** after J05.

## Goal
Add a "Databases" dropdown to the top-left of the topbar with three actions — Connect New, Make New, Manage Connections — each wired to the relevant data-source / DB flow. This pairs with J27 (open-dataset reference in the data panel).

## Changes
- **network_toy/app/src/ui/topbar.js** — add a Databases dropdown at the top-left. Mirror the existing top-right cart precedent (`renderCart` ~L132) for the button/menu pattern. The dropdown exposes: Connect New, Make New, Manage Connections.
- **New modals (network_toy/app/src/ui/modals/)** — connect / make / manage modals as needed; each opens via the existing `openModal` contract.
- **Wiring** — route each action into the dataset / `serve.py` flow established by J05 and the data-source layer (network_toy/app/src/datasource/sqlite.js + real.js).

## OPEN QUESTION (flag / confirm with user before implementing)
Define exactly what each action does:
- **Connect New** = attach an existing biblion DB.
- **Make New** = init a new DB.
- **Manage Connections** = list / switch / remove connected DBs.
Confirm these definitions (and whether multiple DBs can be connected at once) with the user before building the modals.

## Verification
- In a real browser (Playwright / webapp-testing): confirm the Databases dropdown appears at the top-LEFT of the topbar and opens to show Connect New / Make New / Manage Connections.
- Trigger each action and confirm its modal opens and wires into the dataset / `serve.py` flow (e.g. Connect New attaches a DB and it becomes the active source).
- Confirm the existing top-right cart button still renders and works (no regression in `renderCart`).
