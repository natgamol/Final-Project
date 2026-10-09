# Rollout plan: review/kikim-animation fixes (written 2026-10-09, nothing deployed)

This is the order to ship the fixes on `review/kikim-animation` without breaking
any client, including old Android builds and web tabs left open. **Nothing in this
document has been deployed.** Every production step goes through
`scripts/deploy-guard.cjs`, which refuses unless HEAD is origin/master (or a
named release commit containing it), the tree is clean, and a person types the
commit id.

## What production runs today (read-only checks on 2026-10-09)

| Surface | Last deployed | What it is |
|---|---|---|
| Firestore rules | 2026-10-03 18:25 UTC | origin/master's rules **plus an uncommitted `studentId` profile field** — matches no commit on any branch |
| Web hosting | 2026-10-03 18:27 UTC | origin/master's app (KIKIM's animation/tour/widget work, natgamol's weekly/daily budgets) **plus an uncommitted editable student ID** (`updateProfileDetails({studentId})`) |
| `saveReviewedReceipt` | 2026-09-11 | pre-dedupe version (before KIKIM's backend change) |
| `analyzeScan` | 2026-09-17 | after `cd6a149`, before `93fc1c3` — so most likely **without** the bank-slip certainty regression fixed by `adf2622` (cannot be proven byte-for-byte: it may have been deployed from an uncommitted tree) |
| `smartLifeAssistantReply` | 2026-10-01 | redeployed with no matching `functions/` commit — origin unknown |
| Storage rules | 2026-09-08 | identical to every commit; untouched by this work |
| Android (MuMu Device-1) | APK of 2026-08-20 | pre-widget native build |

Both Oct 3 deploys came from a working tree that is not on any branch — the
same shape as the earlier production overwrite. **Whoever made them needs to
commit and push the `studentId` rules and client code before anything else is
deployed from master**, or the next rules or web deploy will silently remove it.

## The coupled change

Three pieces only work as a set:

1. **Rules** — clients may no longer create a transaction with
   `source: 'receipt_scan'`; updates validate only the keys a write changes.
2. **`saveReviewedReceipt`** — runs the dedupe check and the write in one
   transaction, records `receiptDedupe/{hash}` markers (server-only collection;
   no client rule needed), accepts `reference`, returns
   `{duplicate, transactionId}` (was `{transactionId}`).
3. **`scan-save.ts`** — new clients save receipts through that callable instead
   of writing the transaction directly.

## What happens to old clients

The tightened rule has **already been live since 2026-10-03**, so this is
observed state, not a forecast:

- **Old builds write receipt transactions directly with no `source` field**
  (checked in master `2fdffb4` and in the code of the 2026-08-20 APK era). The rule
  is `!('source' in data) || source == 'manual_entry'`, so those writes are
  **still accepted**. No old client sends `source: 'receipt_scan'`, so none is
  refused.
- What old clients do **not** get is dedupe: their direct writes bypass the
  callable, so a receipt scanned twice on an old build can still be saved twice
  until that build updates. (The rule's comment overstates this: refusing
  `receipt_scan` stops a client *labelling* a forged row, not a client writing
  an unlabelled one.)
- **Updates** under the changed-keys rules: the notes whitelist is every key
  `validNote` allows except `ownerId`, `createdAt` and `scanLogId` (deliberately
  frozen); activities and transactions keep their existing whitelists. No
  update an old or new client makes loses a key.
- **`saveReviewedReceipt`'s new return value** keeps `transactionId`, so any
  caller reading only that keeps working; the new `duplicate` flag is optional.
- Open web tabs keep their old bundle until reloaded (`index.html` is served
  `no-cache`), and behave like an old client: compatible.

## Order

0. **Reconcile production drift.** Get the `studentId` rules + client change
   committed to master (see above). Until then, do not deploy rules or web from
   master.
1. **Merge this branch into master** (a person, not this review). One conflict,
   in `src/screens/native/user/assistant-screen.tsx`, against natgamol's
   `d29124a`: keep both — call `runAutoAction()` (the effect event from
   `0d8297d`), then natgamol's `router.setParams({autoAsk: undefined,
   autoListen: undefined})`, and drop the `eslint-disable` line. Every other
   file merges cleanly (checked with `git merge-tree`).
2. **Functions:** `npm run deploy:scan-functions` — `analyzeScan` and
   `saveReviewedReceipt` only. Safe for every client (see above); from this
   moment the live web client gets dedupe. Do **not** use `deploy:functions`
   (all functions) until someone confirms what `smartLifeAssistantReply` was
   deployed from on 2026-10-01. Never deploy `analyzeScan` from a commit that
   has KIKIM's classifier change without `adf2622`: that skips the Gemini
   review for bank transfer slips.
3. **Rules:** this branch changes no rules. After step 0, master's rules should
   equal what is live; `npm run deploy:firestore-rules` prints the diff against
   master before asking. **Never deploy rules from `review/kikim-animation`
   itself**: it predates natgamol's weekly/daily budget fields (live web uses
   them) and the `studentId` field, so both would start failing.
4. **Web:** `npm run deploy:web` from master — ships the timetable error
   messages, the lint fixes and the widget guard (a no-op on web).
5. **Android:** the JS fixes can go out as `npm run update:production` (OTA);
   `6da1dcc` makes that safe for pre-widget APKs. The home-screen widgets
   themselves need a new native build — a separate decision.

## Known issue not fixed in this round

The guided tour can start for a screen that is **not** the visible one: expo-router
keeps earlier screens mounted under the current one, and each calls
`maybeStartTour` when the previous tour ends. Reproduced on MuMu twice: the
calendar tour drawn over the dashboard, and the dashboard tour drawn over Smart
Scan opened by deep link (the path a notification takes). Its spotlight then
lands on whatever sits at those coordinates, and once the overlay froze the
whole screen until the app was restarted. origin/master has the same code (no
focus gating), so production very likely has it too. Suggested fix: gate
`maybeStartTour` and `useTourTarget` on screen focus (`useIsFocused`) and end the
active tour when its screen blurs.
