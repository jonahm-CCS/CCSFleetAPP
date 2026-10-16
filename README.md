[README.md](https://github.com/user-attachments/files/33545757/README.md)
# CCS Fleet — hosted edition

Node.js 24 + SQLite on a Render persistent disk. Read **HOSTING-GUIDE.txt** for the complete deployment, Google sign-in, initial database migration, backup and update steps.

The repository contains application code, OCR language data and reference evidence images. Keep it private. Live fleet data is imported by an administrator after deployment and resides at `/var/data/fleet.sqlite`; it is never copied from this package on redeploy.

- `npm ci --omit=dev`: install pinned dependencies.
- `npm test`: run hosted authentication, migration, access and persistence checks.
- `npm start`: start with the environment configuration documented in the guide.
- `render.yaml`: paid single-instance service with a 10 GB persistent disk.

All existing features through v0.8.2 are included: source reconciliation, CC-controlled drivers, insurance add/remove lists, automatic vehicle links, Samsara equipment checks, disposed storage, searchable pickers and filtered CSV exports.

Prepared for deployment; account configuration and a live sign-in test are still required.
