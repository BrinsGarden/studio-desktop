import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { store } from './store'
import * as actions from './actions'
import * as types from './engine/types'
import * as io from './engine/io'
import * as render from './engine/render'

// Scripting hook: lets an assistant (or the browser console) inspect and adjust layers precisely.
;(window as unknown as { studio: unknown }).studio = { store, actions, types, io, render }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
