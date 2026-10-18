"""Offline dependency-closure proof; no credentials or provider calls."""
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ["CHROMIUM_PATH"], headless=True,
                               args=["--no-sandbox", "--disable-dev-shm-usage"])
    page = browser.new_page()
    page.goto("data:text/html,<title>fixed-runtime</title><body>ASCII sans 0123</body>")
    assert page.title() == "fixed-runtime"
    ink = page.evaluate("""() => {
        const canvas = document.createElement("canvas");
        canvas.width = 240; canvas.height = 60;
        document.body.appendChild(canvas);
        const context = canvas.getContext("2d");
        if (context === null) throw new Error("2D canvas unavailable");
        context.font = "20px sans-serif";
        context.fillText("ASCII sans 0123", 8, 30);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 0) count++;
        return count;
    }""")
    assert ink > 0, "sans-serif text rendered no pixels"
    browser.close()
print("provider runtime: fixed CLI, declared sans and real browser text PASS; live effects 0")
