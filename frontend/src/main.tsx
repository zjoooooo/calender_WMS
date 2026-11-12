import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/tokens.css';
import App from './App';
import { getLook, setLook } from './ui/style';

setLook(getLook());

const root = createRoot(document.getElementById('root')!);
if (__WMS_DEMO__) {
  // Calendar demo build (§11.5): starts the backend in this tab first (src/demo), then shows the app.
  import('./demo/DemoApp').then(
    ({ default: DemoApp }) =>
      root.render(
        <StrictMode>
          <DemoApp />
        </StrictMode>,
      ),
    (e: unknown) => {
      // The demo's own code did not load (network): its error screen, in both languages, as the demo's texts
      // are in that code.
      console.error(e);
      root.render(
        <div className="center-screen">
          <div className="card" role="alert" style={{ maxWidth: 460, display: 'grid', gap: 10 }}>
            <p className="form-error" style={{ margin: 0 }}>
              演示无法启动 · The demo could not start: {e instanceof Error ? e.message : String(e)}
            </p>
            <button type="button" className="btn primary" onClick={() => location.reload()}>
              重试 · Try again
            </button>
          </div>
        </div>,
      );
    },
  );
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
