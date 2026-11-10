# Fleet Slack connection

The app has a **Slack updates** inbox and a **Slack inspections** tab on each vehicle. Monitoring is not active until the following setup is completed.

## One-time setup

1. Create a Slack app in the CCS workspace at https://api.slack.com/apps . Give its bot the `channels:history` scope, install it, and invite it to **fleet-management-ops** (`C0A65AH12BU`).
2. In Supabase Edge Function secrets, set `FLEET_SLACK_SIGNING_SECRET` to that app's Signing Secret from Basic Information. Set `FLEET_SLACK_START_TS` to the current Unix timestamp (seconds). Keep secrets in Supabase, never GitHub or chat.
3. Enable Event Subscriptions with this Request URL:

   `https://evrwtxpmhycbtvuclifb.supabase.co/functions/v1/fleet-slack`

4. Subscribe to bot event `message.channels` and save. Reinstall the app if Slack requests it.
5. Verify the next real CCS notification appears in **Slack updates**. The inbox displays the last received time; a timestamp does not guarantee the subscription remains healthy. Check Slack delivery errors if messages stop arriving.

## Behavior

Only workspace `T05KD0PN5K9`, channel `C0A65AH12BU` is accepted. Signed requests are required. Only the verified CCS employee notification bot (`U0B585HSK28`) can automatically change employee status.

- **Employee activated:** adds a driver without requiring CC or insurance, or restores a uniquely matched existing driver. Existing identity conflicts go to review.
- **Employee deactivated:** archives the uniquely matched driver and releases their fixed vehicle assignment. History is retained.
- **Fleet Change of User:** captured for review. Select the vehicle and incoming driver, then apply the swap using the existing assignment safeguards.
- **Vehicle Check:** captured for review. Select the vehicle to attach the report. Its Slack link opens photos and discussion. Complete the physical verification checklist separately; a partial report does not verify every check.
- Services vehicles keep pooled assignments. Duplicate employee notices are ignored. Messages older than enablement or a newer driver update are not automatically applied. Ordinary chatter, edits, and thread replies are ignored.

For employee notices requiring review, use Driver Register to resolve the identity or archive/restore, then dismiss the notice. No historical channel messages are imported automatically.

Workflow detection currently recognizes the Vehicle Check question “Who is the current driver?” and swap messages containing “Fleet Change of User” or “New Responsible User”. If the swap workflow uses another message format, supply one example so the parser can be extended. Photos stay in Slack and require Slack access.

The receiver commits before acknowledging delivery; timeouts return an error for Slack to retry. Deduplication and revision checks prevent repeated or concurrent deliveries overwriting one another. Monitor delivery latency and errors after enabling.

The ChatGPT Slack connection is separate from this persistent Slack app subscription.
