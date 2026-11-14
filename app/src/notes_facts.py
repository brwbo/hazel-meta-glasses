import re

SYSTEM = re.compile(r"^named from speech", re.I)
PLACEHOLDER = re.compile(r"guest \d+", re.I)
NAME_INTRO = re.compile(r"^(?:hello|hi|hey)?[,!. ]*my name(?: is|'s)\b", re.I)
TAIL = r"([^.,;!?]+?)(?=\s+(?:and|but|so|with|because)\b|[.,;!?]|$)"
RULES = [
    (re.compile(r"\bborn in " + TAIL, re.I), lambda m: f"was born in {m.group(1)}"),
    (re.compile(r"\bI(?:'m| am) from " + TAIL, re.I), lambda m: f"is from {m.group(1)}"),
    (re.compile(r"\b(?<!not )(?:live|living) in " + TAIL, re.I), lambda m: f"lives in {m.group(1)}"),
    (re.compile(r"\bwork(?:ing)? (as|at|for) " + TAIL, re.I), lambda m: f"works {m.group(1)} {m.group(2)}"),
    (re.compile(r"\bI(?:'m| am) (an? [^.,;!?]+?)(?=[.,;!?]|$)", re.I), lambda m: f"is {m.group(1)}"),
    (re.compile(r"\bstud(?:y|ying) ([^.,;!?]+?)(?=[.,;!?]|$)", re.I), lambda m: f"studies {m.group(1)}"),
]


def is_placeholder(name):
    return not name or bool(PLACEHOLDER.fullmatch(str(name).strip()))


def clauses(texts):
    found, seen = [], set()
    for text in texts:
        for rule, build in RULES:
            for m in rule.finditer(" ".join(str(text).split())):
                clause = build(m).strip()
                key = clause.lower()
                if 6 <= len(clause) <= 70 and key not in seen:
                    seen.add(key)
                    found.append(clause)
    return found


def third_person_summary(name, texts):
    found = clauses(texts)[:3]
    if not found:
        return ""
    subject = "This person" if is_placeholder(name) else str(name).strip()
    body = found[0] if len(found) == 1 else ", ".join(found[:-1]) + " and " + found[-1]
    return f"{subject} {body}."


def introduced(name):
    return "Introduced themselves." if is_placeholder(name) else f"Introduced themselves as {str(name).strip()}."
