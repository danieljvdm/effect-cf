export const renderShell = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Architect Lab</title>
    <link rel="stylesheet" href="/assets/app.css" />
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19.2.6",
          "react/jsx-runtime": "https://esm.sh/react@19.2.6/jsx-runtime",
          "react-dom": "https://esm.sh/react-dom@19.2.6",
          "react-dom/client": "https://esm.sh/react-dom@19.2.6/client",
          "sugar-high": "https://esm.sh/sugar-high@1.2.0",
          "tldraw": "https://esm.sh/tldraw@5.0.1?deps=react@19.2.6,react-dom@19.2.6",
          "@tldraw/sync": "https://esm.sh/@tldraw/sync@5.0.1?deps=react@19.2.6,react-dom@19.2.6,tldraw@5.0.1"
        }
      }
    </script>
  </head>
  <body>
    <main id="root"></main>
    <script type="module" src="/assets/app.js"></script>
  </body>
</html>`;
