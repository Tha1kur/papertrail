import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { rehypeHighlight } from "@/lib/rehypeHighlight";

/**
 * The markdown renderer, isolated in its own module so it can be code-split.
 *
 * None of this is needed to paint the sign-in screen or the empty state, and
 * it loads while the first reply is generating — dead time either way.
 *
 * Highlighting comes from lib/rehypeHighlight rather than the rehype-highlight
 * package, which carried lowlight's full default grammar set as a static
 * import. Gzipped, for this chunk: 101.9 kB with the package, 73.6 kB with a
 * local plugin over the languages this app actually meets.
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
