import { Component } from "react";

/**
 * A final UI guard for unexpected render failures. Deliberately never renders
 * the thrown error: it could contain data from an unlocked conversation.
 */
export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // Do not send or print exception contents: message and vault data can be in
    // a component tree while the browser is unlocked.
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <h1>Timber needs to restart</h1>
        <p>Your encrypted data remains on this device. Reload to reconnect safely.</p>
        <button className="btn-wood" onClick={() => window.location.reload()}>Reload Timber</button>
      </main>
    );
  }
}
