import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import './index.css';
import Library from './pages/Library';
import BookDetail from './pages/BookDetail';
import Voices from './pages/Voices';
import VoiceExpert from './pages/VoiceExpert';
import Queue from './pages/Queue';
import Exports from './pages/Exports';
import Settings from './pages/Settings';

const navItem =
  'px-3 py-1.5 rounded-lg text-sm transition-colors hover:bg-zinc-800 ' +
  '[&.active]:bg-zinc-700 [&.active]:text-white';

function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex flex-col">
        <header className="border-b border-zinc-800 bg-zinc-900/60 backdrop-blur sticky top-0 z-10">
          <div className="mx-auto max-w-6xl px-4 h-14 flex items-center gap-6">
            <NavLink to="/" className="font-semibold tracking-tight text-lg">
              🎧 Audiobook Studio
            </NavLink>
            <nav className="flex gap-1">
              <NavLink to="/" end className={navItem}>Library</NavLink>
              <NavLink to="/queue" className={navItem}>Queue</NavLink>
              <NavLink to="/exports" className={navItem}>Exports</NavLink>
              <NavLink to="/voices" className={navItem}>Voices</NavLink>
              <NavLink to="/settings" className={navItem}>Settings</NavLink>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl w-full px-4 py-6 flex-1">
          <Routes>
            <Route path="/" element={<Library />} />
            <Route path="/books/:id" element={<BookDetail />} />
            <Route path="/queue" element={<Queue />} />
            <Route path="/exports" element={<Exports />} />
            <Route path="/voices" element={<Voices />} />
            <Route path="/voices/:id/expert" element={<VoiceExpert />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
