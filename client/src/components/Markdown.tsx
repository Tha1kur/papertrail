import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

/**
 * The markdown renderer, isolated in its own module so it can be code-split.
 *
 * Measured contributions to the bundle:
 *   react + react-dom    180 kB
 *   + react-markdown     297 kB
 *   + remark-gfm         335 kB
 *   + rehype-highlight   509 kB
 *
 * rehype-highlight is by far the largest single item, and its `languages`
 * option adds to lowlight's default set rather than replacing it — so
 * trimming the language list does not help. Splitting does: none of this
 * is needed to paint the sign-in screen or the empty state, and it loads
 * while the first reply is being generated, which is dead time anyway.
 *
 * Default export because React.lazy requires one.
 */
export default function Markdown({ content }: { content: string }) {
  return (
    /**
     * No rehype-raw, deliberately. react-markdown escapes HTML by default,
     * and model output is untrusted text — enabling raw HTML here would turn
     * any prompt injection into stored XSS.
     */
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
      {content}
    </ReactMarkdown>
  );
}
