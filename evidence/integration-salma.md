# End-to-end tests: Transactions service (Salma), run on Floci

Run: 2026-11-27T20:23:10.422Z against http://5b5e788b2e.execute-api.localhost.floci.io:4566. Script: tests/security/transactions-e2e.mjs (month 2026-11)

| Test ID | Category | Scenario | Expected | Actual | Pass/Fail |
|---|---|---|---|---|---|
| IT-04 | Transactions + external API | Log 10 USD in Fun; then currency "XYZ" | 201 with amountBase = 10 x live rate; XYZ 400 | 201 10 USD -> 548.19 EGP at 54.818684 (open.er-api.com); XYZ 400 VALIDATION_ERROR | Pass |
| IT-08 | Transactions -> Buckets | Change the expense from 10 to 200 USD (over the 5,000 EGP Fun limit); try to change the date | 200 and Fun OVER_LIMIT (soft limit warns, does not block); date change 400 | edit 200 amount=200 USD (10963.74 EGP), Fun state=OVER_LIMIT; date change 400 VALIDATION_ERROR | Pass |
| IT-09 | Transactions + Insights | Add income 15,000 and a card expense 300; filter by card; compare the list totals with the dashboard; invalid month | only card items; list totals equal the dashboard; 400 | card filter 200 items=1 only card=true; list income=15000 expense=11263.74; dashboard 200 income=15000 expense=11263.74; month 2026-13 400 VALIDATION_ERROR | Pass |
| IT-13 | Transactions (double submit) | The same expense sent twice at the same moment (double click); an unsafe ticket | 201 + 200 duplicate, 1 saved; unsafe ticket 400 | 200 + 201, duplicate flag=true; saved 1; unsafe ticket 400 VALIDATION_ERROR | Pass |
| IT-14 | Transactions + S3 (receipts) | Ask for an upload form, upload a real PNG to S3, confirm it, open it through the short-lived link | 201; S3 2xx; 200 hasReceipt; 200 link; download 200 with the same file | form 201 (max 5242880 bytes); S3 204; confirm 200 hasReceipt=true; link 200 expires in 300s; download 200, same file=true | Pass |
| IT-15 | Transactions + Neon (audit) | Normal user and admin ask for the audit analytics; admin asks for 500 days | 403; 200 from Neon with counts per action (CREATE, UPDATE...), no user ids, amounts or notes; 400 | normal user 403 FORBIDDEN; admin 200 source=neon events=10 activeUsers=2 actions=CREATE,DELETE,DELETE_ALL,RECEIPT_ATTACH,UPDATE; user ids/amounts/notes in the answer=false; days=500 400 VALIDATION_ERROR | Pass |
| IT-16 | Transactions + S3 + Neon (privacy) | Export my data; delete without confirm; delete with confirm; list again | 200 with 4 transactions and no internal fields; 400; 200 deletes 4 transactions, 1 receipt and the audit rows; 0 left | export 200 count=4, internal fields=none; no confirm 400 VALIDATION_ERROR; delete 200: transactions 4, receipts 1, audit rows 6; list afterwards total=0 | Pass |

7 of 7 passed. IT-11 (exchange-rate API down) is covered by unit test TX-06.
