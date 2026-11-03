# CCS Fleet: GitHub Pages + Supabase

The website stays at https://jonahm-ccs.github.io/CCSFleetAPP/.
This branch prepares the editable shared version. It is not yet deployed.

## Architecture

GitHub Pages serves the interface. A Supabase Edge Function runs the existing reconciliation and fleet rules. Postgres stores shared records with an atomic revision check; concurrent changes return a conflict rather than overwriting another employee's work. Uploaded source files and attachments are stored in the private `fleet-files` bucket and downloaded through the API. The API is designed for public access without sign-in, as requested; deployment requires explicit public-write approval. No secret keys belong in this repository or browser code.

PDF and Word text/OCR extraction happens in the browser using pinned PDF.js, Tesseract, and JSZip versions. OCR and source-matching exceptions remain reviewable. CSV and Excel parsing runs in the Edge Function. Large scanned documents can take time.

## Migration and data

The initial shared state comes from the existing published snapshot: 130 vehicles, 45 CC drivers, and 175 insurance names reconstructed from the published comparison/evidence. Original source files and old audit history were not present in that snapshot. The original snapshot remains in Git for recovery and tests; the new interface does not read it. Changes made locally after the snapshot date are not included automatically.

The latest 30 committed state revisions are retained in Postgres for rollback. The in-app JSON backup contains records and uploaded-file references; it does not embed Storage file bytes. Back up the Storage bucket separately for complete disaster recovery.

## Setup and deployment

1. Apply `supabase/migrations/20261103_shared_fleet.sql` once to the intended Supabase project.
2. Initialize `fleet_state` from `scripts/seed-from-snapshot.mjs`; do not reseed an active project.
3. Deploy `supabase/functions/fleet-api` after public-write approval. This version intentionally uses `verify_jwt=false`; all visitors can read and modify data. The function accesses Postgres and Storage using server-managed environment secrets.
4. Verify the health endpoint and real upload/edit/download tests before merging the frontend to the Pages publishing branch.
5. The API address is declared at the top of `app.js`. Keep the GitHub Pages publishing source unchanged.

The database and storage bucket have been provisioned. Edge Function deployment and the Pages switch are pending. Employee-number lockouts are not included in this no-sign-in version.

## Checks

Run `npm install` then `npm test` with Node 24. Tests cover migration parity, version conflicts, uploads, aliases, crash history, and invalid input. Live Edge Function and browser OCR tests must pass before publication.
