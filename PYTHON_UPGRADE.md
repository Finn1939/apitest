# Capri’s Python upgrade

| Surface | Changes |
| --- | --- |
| Text chat and server requests | Local routing starts Discord typing before the planner, attachment reads, and memory lookups. Common chat requests skip planning. Server actions and reviewers send an acknowledgment from the loaded personality file before the first model call. |
| Availability and error replies | Timeouts, throttling, missing permissions, missing targets, malformed plans, empty sheets, bad sources, and unexpected exceptions have offline replies. Raw exception details go to process logs. The message, slash-command, and confirmation-button paths have error handlers. |
| Authorization and deletion | A populated USERID takes precedence over the Python command list and admin override. Spoken and typed delete requests both post the same confirmation in text. The requester gets two minutes to choose “Yes, delete it” or “Leave it alone.” Longer plans include a full attachment. Only a positive decision runs the plan. |
| Action results | Capri reports verified step results directly, including the step that stopped a plan. This removes the second generation call and the full directory refresh before reporting. Server event handlers continue to update the directory. |
| Voice and slash commands | Reworded help, server-only prompts, join/leave/say responses, confirmation ownership, status intros, and voice loss, silent-input, playback, and transcription notices. Technical metrics remain available through /vc_status. |
| Memory and model calls | Startup loads the persona and acknowledgment pools once. Gemini uses its async client. Each chat/planner/reviewer generation has a 60-second deadline. SQLite work uses a serialized worker, member snapshots batch writes, and ordinary chat uses up to 12 recent channel entries capped at 450 characters each. |
| Study files | The controller can request a reviewer, study guide, notes, or Markdown file using a topic, pasted material, or attachments. Supports UTF-8 TXT, MD, CSV, PY, JSON, and PDFs with selectable text. Four files maximum, 4 MiB each, 60,000 extracted characters combined, and 80 pages per PDF. PDF parsing runs off the Discord event loop. The file is sent from memory. |

## Dependencies and verification

Added pypdf for selectable-text PDFs. Pinned the existing voice-receive dependency to the prerelease recorded in the supplied voice handoff. The JavaScript launcher retains its separate behavior.

From the project root run `python -m unittest discover -s python` with the requirements installed. The dependency-light checks cover routing, delete classification, provider selection, acknowledgment ordering, UTF-8 file bytes, invalid sources, and offline failures. Discord delivery, active permissions, voice playback, and model tone depend on the running deployment.

## Live conversation

Join a voice room, then use `/vc_join` in the text channel where you want receipts, files,
and deletion buttons. Check `/vc_status` for active listening. An existing TTS-only session
gets a fresh listening connection when you explicitly join again.

Anyone can talk with Capri. A controller can say “Capri, give Kai the DJ role” or “Capri,
make me a reviewer on SQL joins.” Capri queues a spoken acknowledgment before planning or
generation. The attached Markdown and complete action result go to the paired text channel.
Voice requests use the same permission and confirmation code as typed requests. A spoken
“yes” cannot approve a deletion.

Each speaker has a separate live transcription connection keyed to their Discord account.
The first uses the preconnected socket. Additional simultaneous speakers use additional
provider sessions, subject to the account’s concurrency quota. Extra sessions close after
a minute of inactivity. Only final transcripts enter command routing. Ordinary conversation
streams generated sentences into the Fish speech queue and reuses the HTTP connection
during the call. Audio already queued, provider latency, and Discord voice encryption
readiness all affect when listeners first hear Capri.
