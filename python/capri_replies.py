"""Offline lines written for the voice in personality.txt."""
import random
import json


DENIED = "We can talk. The server keys stay with the person who holds them."
CONFIRM = "Yes, delete it"
CANCEL = "Leave it alone"


class SourceProblem(ValueError):
    """A fixed, user-facing explanation for unusable study material."""


ACKS = {
    "study": ["Got you. I’m pulling the study sheet together.",
              "Give me a beat. I’m laying out the notes and practice questions."],
    "action": ["Heard you. Let me check what that takes.",
               "On it. I’ll tell you what goes through."],
}


def load_acknowledgments(personality):
    """Read optional curated lines from the same persona file, once at startup."""
    start = "<acknowledgments>"
    if start not in personality:
        return
    block = personality.split(start, 1)[1].split("</acknowledgments>", 1)[0]
    pools = json.loads(block)
    for key in ACKS:
        pool = pools[key]
        if not isinstance(pool, list) or not pool or not all(isinstance(line, str) and 0 < len(line.strip()) <= 160 for line in pool):
            raise ValueError(f"Invalid acknowledgment lines in personality.txt for {key}")
        ACKS[key] = pool


def acknowledgment(study=False):
    return random.choice(ACKS["study" if study else "action"])


def failure(exc):
    if isinstance(exc, SourceProblem):
        return str(exc)
    status = getattr(exc, "status", None) or getattr(exc, "status_code", None) or getattr(exc, "code", None)
    kind = type(exc).__name__.lower()
    if status == 429 or "ratelimit" in kind or "cooldown" in kind:
        return "Hit the brakes on that one. Give it a little room before the next run."
    if isinstance(exc, TimeoutError) or "timeout" in kind:
        return "Been waiting on that signal too long. I can’t vouch for what got through."
    if isinstance(exc, PermissionError) or status == 403 or "permission" in kind or "forbidden" in kind:
        return "That door’s locked on my side. Check my channel access and where my role sits."
    if status == 404:
        return "Lost sight of that target. Still there? Drop me its link."
    if isinstance(exc, ValueError) or "transformer" in kind:
        return "Can’t pin down that move. Give me the exact target and what you want changed."
    return "Lost the thread on my end. I can’t call that one finished."


def receipt(results):
    lines = []
    for line in results:
        if line.startswith("Step ") and ") failed: " in line:
            step, detail = line.split(") failed: ", 1)
            lines.append(f"I stopped at {step.lower()}). {detail}")
        else:
            lines.append(line)
    body = "\n".join(lines)
    if len(body) > 1830:
        body = body[:800] + "\n…\n" + body[-1000:]
    return "Here’s what came back.\n" + body
