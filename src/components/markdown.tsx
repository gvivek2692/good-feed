/**
 * A deliberately small markdown renderer for deep-dive content.
 *
 * The prompt constrains output to `##` headings, paragraphs, and occasional
 * bold or inline code, so a full markdown dependency would be mostly unused
 * surface area — and AGENTS.md puts new dependencies behind "ask first".
 * Everything renders as React elements rather than `dangerouslySetInnerHTML`,
 * so model output can never inject markup.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  // Split on bold and inline code, keeping the delimiters.
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);

  return parts.filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;

    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold text-zinc-900 dark:text-zinc-100">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[0.9em] text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

export function Markdown({ content }: { content: string }): React.ReactElement {
  const blocks = content.split(/\n{2,}/).filter((block) => block.trim());

  return (
    <div className="space-y-6">
      {blocks.map((block, index) => {
        const trimmed = block.trim();
        const key = `block-${index}`;

        const heading = /^(#{2,4})\s+(.*)$/.exec(trimmed);
        if (heading) {
          const level = heading[1].length;
          const text = heading[2];
          const className =
            level === 2
              ? "mt-10 text-[1.3rem] font-semibold tracking-[-0.015em] text-zinc-900 dark:text-zinc-50"
              : "mt-8 text-[1.0625rem] font-semibold text-zinc-900 dark:text-zinc-100";

          return level === 2 ? (
            <h2 key={key} className={className}>
              {text}
            </h2>
          ) : (
            <h3 key={key} className={className}>
              {text}
            </h3>
          );
        }

        // A run of list items arrives as one block.
        if (/^[-*]\s/m.test(trimmed)) {
          const listItems = trimmed.split("\n").filter((line) => /^\s*[-*]\s/.test(line));
          if (listItems.length > 0) {
            return (
              <ul key={key} className="list-disc space-y-2 pl-5">
                {listItems.map((line, itemIndex) => (
                  <li
                    key={`${key}-${itemIndex}`}
                    className="text-[17px] leading-[1.75] text-zinc-700 dark:text-zinc-300"
                  >
                    {renderInline(line.replace(/^\s*[-*]\s/, ""), `${key}-${itemIndex}`)}
                  </li>
                ))}
              </ul>
            );
          }
        }

        return (
          <p key={key} className="text-[17px] leading-[1.75] text-zinc-700 dark:text-zinc-300">
            {renderInline(trimmed, key)}
          </p>
        );
      })}
    </div>
  );
}
