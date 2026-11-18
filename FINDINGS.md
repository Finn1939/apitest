# Capri outbound voice: likely cause and fix

**Most likely cause: DAVE (Discord E2EE voice) is negotiated but never becomes ready on the bot.**
Status shows `DAVE protocol: 1`, `DAVE ready: False`, `DAVE encrypting outbound: False`.
Fish TTS, resampling, Opus and the player all work (bytes, frames, RMS 5809 are healthy), but frames are
sent without the DAVE layer, so other clients drop them. UDP has no ack and discord.py only DEBUG-logs
send failures, which is why everything looks fine locally. Speak permission/mute/Stage are all fine.

## Changes (voice_live.py, bot.py)
- `dave_state()`, `dave_blocking_audio()`, `wait_for_dave()` on `CapriVoiceSession`.
- `_speak_loop` waits up to 15 s for DAVE before calling Fish; if it never becomes ready it posts the text instead of "speaking" into silence.
- `/vc_beep` warns when DAVE is not ready.

## Next diagnostics (not verified here; discord.py not installed in my sandbox)
1. `/vc_join` then `/vc_status` right away and again after ~10 s: does `DAVE ready` flip to True?
2. If it stays False: confirm `davey` imports in the same `.venv`, and grep logs for
   "MLS welcome/commit processed" (filtered in `_VoiceHandshakeFrameFilter`; temporarily allow them through).
   A missing welcome/commit means the MLS group never included the bot.
3. Check `dave_receive.py`'s `set_passthrough_mode` isn't affecting the session, and try discord.py latest + `davey` latest.
4. If DAVE becomes ready and `/vc_beep` is still silent, test from a second client and check UDP egress/firewall.
