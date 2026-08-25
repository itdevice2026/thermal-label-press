# Thermal Label Press

Customer-based Code 128 label generator for Zebra and Godex thermal printers.
Built to reproduce an existing printed label exactly — same layout, same
typewriter face, same encoded data — while replacing the manual process behind it.

## What it does

- **Prints product labels** carrying product name, pack size, production date,
  expiry date, a Code 128 barcode and its number.
- **Keeps a customer list.** Every product belongs to a customer, and each
  customer can have its own label stock size. A run that mixes customers prints
  each label at its own page size.
- **Records every run** — date, operator, customer, product, barcode, quantity —
  in a print log you can export.
- **Two ways out to the printer:** normal browser printing with the page size
  embedded in millimetres, or a ZPL block you can send straight to a Zebra
  (or a Godex in ZPL emulation).

## The label format

The layout was measured off the original printout rather than guessed:

| | |
|---|---|
| Symbology | Code 128 |
| Encoded data | the number **plus a trailing line feed**, so a scan types the code and presses Enter |
| Text | Courier (bold), all four lines at one size and one pitch |
| Number | Arial (bold), 1.08× the text size |
| Proportions | line pitch 1.115 × text · bar height 3.94 × text · barcode width 0.649 × label width · block fills 0.90 of the label height |

The bars this app renders are run-for-run identical to the original printout's
own bar pattern. `test/` checks that, and that every rendered label still scans.

## Running it

It is a static page — no build step, no bundler.

```sh
python3 -m http.server 8000     # then open http://localhost:8000
```

`config.js` points at the Supabase project. The publishable key there is meant
to be public; it identifies the project and grants nothing on its own.

## Accounts

Real Supabase accounts. People sign up themselves with a company email address;
the **first account ever created becomes the administrator**, and everyone after
that lands as *pending* — able to sign in, able to see nothing — until an
administrator gives them a role on the Users tab.

| Role | Can |
|---|---|
| Operator | Print, and read the print log |
| Administrator | Everything, including products, customers, label setup and roles |

These rules are enforced by row-level security in Postgres, not by this page, so
they hold no matter how the page is opened or edited. `supabase/migrations`
contains the schema and every policy.

## Layout

```
index.html         markup
styles.css         one theme, light and dark
js/core.js         data layer, storage, sign-in
js/label.js        Code 128 encoder, label renderer, ZPL
js/lists.js        products, customers, queue, print log
js/setup.js        label setup, auto-fit, CSV
js/wiring.js       event wiring and boot
supabase-lite.js   the slice of Supabase this app uses, hand-written, no CDN
config.js          project URL and publishable key
offline/           single-file build for a label PC with no internet
supabase/          schema and row-level security
test/              headless browser tests against an in-memory server
```

## The offline build

`offline/Thermal-Label-Press.html` is the whole app in one file, with local
storage and a PIN-based sign-in instead of accounts. It is for a label station
with no reliable internet. Its sign-in is a workflow gate, not security —
anyone with the file can bypass it. Products and customers export as CSV from
there and import here.

## Tests

```sh
python3 test/run.py
```

Drives a real headless browser through sign-up, roles, CRUD and printing against
an in-memory stand-in for the server, renders the printed pages to PDF and scans
the barcodes back out of them.
