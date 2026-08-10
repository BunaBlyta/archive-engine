import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "../lib/constants";

export function SearchSnippet({ snippet }: { snippet: string }) {
  const parts = snippet.split(SEARCH_HIGHLIGHT_START);

  return (
    <>
      {parts.map((part, index) => {
        if (index === 0) return <span key={index}>{part}</span>;

        const [match, ...rest] = part.split(SEARCH_HIGHLIGHT_END);
        return (
          <span key={index}>
            <mark className="rounded bg-accent-100 px-0.5 text-inherit">{match}</mark>
            {rest.join(SEARCH_HIGHLIGHT_END)}
          </span>
        );
      })}
    </>
  );
}
