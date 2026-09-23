"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export function SearchFilter({ defaultValue }: { defaultValue: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function handleChange(term: string) {
    const params = new URLSearchParams(searchParams.toString());

    if (term) {
      params.set("search", term);
    } else {
      params.delete("search");
    }
    params.delete("page"); // Reset to page 1 on search

    startTransition(() => {
      router.replace(`?${params.toString()}`);
    });
  }

  return (
    <div className="filter-search">
      <label htmlFor="search">Search {isPending && "(Updating...)"}</label>
      <input
        id="search"
        type="search"
        defaultValue={defaultValue}
        placeholder="IP, MAC, hostname, subscriber..."
        onChange={(e) => handleChange(e.target.value)}
      />
    </div>
  );
}