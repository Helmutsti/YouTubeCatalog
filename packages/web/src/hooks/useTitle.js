import { useEffect } from 'react';

// Titolo della scheda del browser (M33): "<contesto> · Ondo", o solo "Ondo" se
// non c'è un contesto (es. dati non ancora caricati). Ripristina "Ondo" quando
// la pagina viene lasciata.
export function useTitle(text) {
  useEffect(() => {
    document.title = text ? `${text} · Ondo` : 'Ondo';
    return () => { document.title = 'Ondo'; };
  }, [text]);
}
