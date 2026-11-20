"""Build doc/scripts/Dehalo/Dehalo.html from doc/src/Dehalo.html.

$$...$$ becomes a numbered display equation, $...$ inline math (LaTeX -> MathML).
$$\\label{name} ...$$ sets a label; \\eqref{name} in the text gives "(n)" with a link.

Run from anywhere:  uv run --with latex2mathml doc/build_doc.py
"""
import html
import re
from pathlib import Path

from latex2mathml.converter import convert

DOC = Path(__file__).resolve().parent
SRC = DOC / "src" / "Dehalo.html"
OUT = DOC / "scripts" / "Dehalo" / "Dehalo.html"


def mathml(tex: str, display: bool) -> str:
    return convert(html.unescape(tex.strip()), display="block" if display else "inline")


def build(text: str) -> str:
    text = re.sub(r"<!--\s*Source of the Dehalo documentation.*?-->\n", "", text, flags=re.S)
    labels: dict[str, int] = {}
    counter = 0

    def display(m: re.Match) -> str:
        nonlocal counter
        counter += 1
        tex = m.group(1)
        anchor = f"__eq{counter}__"
        lab = re.match(r"\s*\\label\{([^}]+)\}", tex)
        if lab:
            labels[lab.group(1)] = counter
            tex = tex[lab.end():]
        return (f'<div class="pidoc_equation" id="{anchor}">{mathml(tex, True)}'
                f'<span class="pidoc_equation_number">({counter})</span></div>')

    text = re.sub(r"\$\$(.+?)\$\$", display, text, flags=re.S)
    text = re.sub(r"\$(.+?)\$", lambda m: mathml(m.group(1), False), text, flags=re.S)

    def eqref(m: re.Match) -> str:
        n = labels[m.group(1)]
        return f'<a href="#__eq{n}__">({n})</a>'

    return re.sub(r"\\eqref\{([^}]+)\}", eqref, text)


if __name__ == "__main__":
    OUT.write_text(build(SRC.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"wrote {OUT}")
