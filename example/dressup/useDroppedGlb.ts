import { useEffect, useState } from "react";

/**
 * Drag any .glb/.gltf onto the window while the dress-up dimension is open and
 * it becomes the model on the pedestal. Each drop revokes the previous blob URL,
 * so memory stays flat however many models you audition.
 */
export function useDroppedGlb() {
  const [url, setUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    let currentUrl: string | null = null;

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!/\.(glb|gltf)$/i.test(file.name)) return;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = URL.createObjectURL(file);
      setUrl(currentUrl);
      setFileName(file.name);
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, []);

  const reset = () => {
    setUrl(null);
    setFileName(null);
  };

  return { url, fileName, dragging, reset };
}
