"use client";

import { useCallback } from "react";
import { useWriteAccount } from "@/hooks/use-write-account";
import { uploadToPinata } from "@/lib/pinata";

export function usePinataUpload() {
  const writer = useWriteAccount();
  return useCallback(
    (file: File, name?: string, onProgress?: (progress: number) => void) =>
      uploadToPinata(writer?.account, file, name, onProgress),
    [writer?.account],
  );
}
