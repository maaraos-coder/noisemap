import React from 'react'
import ReactDOM from 'react-dom/client'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import App from './App'

class MapErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Noise Map: error de renderizado', error, info)
  }

  render() {
    if (!this.state.error) return this.props.children

    return (
      <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 20, background: '#edf2f7', color: '#163557', fontFamily: 'system-ui, sans-serif' }}>
        <section style={{ width: '100%', maxWidth: 520, padding: 24, borderRadius: 16, background: 'white', boxShadow: '0 8px 32px #09213b20' }}>
          <h2 style={{ marginTop: 0 }}>No se pudo mostrar el mapa</h2>
          <p>El cálculo o la visualización produjo un error. No es necesario cambiar la resolución sin conocer la causa.</p>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: 12, background: '#f1f5f9', borderRadius: 8, fontSize: 12 }}>{String(this.state.error?.message || this.state.error)}</pre>
          <button type="button" onClick={() => window.location.reload()} style={{ padding: '12px 16px', background: '#0b5dc2', color: 'white', border: 0, borderRadius: 8, fontWeight: 700 }}>Volver a abrir el mapa</button>
        </section>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <MapErrorBoundary>
      <App />
    </MapErrorBoundary>
  </React.StrictMode>
)
