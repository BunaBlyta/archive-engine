import { Bold, Heading2, Italic, List } from "lucide-react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { cn } from "../lib/utils";

const MARKDOWN_CONTENT_CLASSES = cn(
  "h-full min-h-[28rem] px-3 py-3 text-sm leading-6 text-neutral-800 outline-none",
  "[&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:first:mt-0",
  "[&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:first:mt-0",
  "[&_h3]:mb-1.5 [&_h3]:mt-3 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:first:mt-0",
  "[&_p]:mb-3 [&_p]:leading-6",
  "[&_ul]:mb-3 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:mb-3 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:mb-1",
  "[&_strong]:font-semibold",
  "[&_em]:italic",
  "[&_a]:text-accent-600 [&_a]:underline",
  "[&_code]:rounded [&_code]:bg-neutral-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]",
  "[&_pre]:mb-3 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-neutral-100 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_blockquote]:mb-3 [&_blockquote]:border-l-2 [&_blockquote]:border-neutral-300 [&_blockquote]:pl-3 [&_blockquote]:text-neutral-600",
  "[&_hr]:my-4 [&_hr]:border-neutral-100"
);

// Keyed by the caller with the draft's id so switching drafts remounts a fresh
// editor instance instead of needing to diff/resync markdown mid-edit.
export default function MarkdownWysiwygEditor({
  content,
  onChange,
}: {
  content: string;
  onChange: (markdown: string) => void;
}) {
  const editor = useEditor({
    extensions: [StarterKit, Markdown.configure({ html: false, transformPastedText: true })],
    content,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: MARKDOWN_CONTENT_CLASSES },
    },
    onUpdate: ({ editor }) => {
      const markdownStorage = editor.storage as unknown as { markdown: { getMarkdown: () => string } };
      onChange(markdownStorage.markdown.getMarkdown());
    },
  });

  const toolbarButtons = [
    { label: "Bold", icon: <Bold className="h-3.5 w-3.5" />, onClick: () => editor?.chain().focus().toggleBold().run() },
    { label: "Italic", icon: <Italic className="h-3.5 w-3.5" />, onClick: () => editor?.chain().focus().toggleItalic().run() },
    { label: "Heading", icon: <Heading2 className="h-3.5 w-3.5" />, onClick: () => editor?.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Bullet list", icon: <List className="h-3.5 w-3.5" />, onClick: () => editor?.chain().focus().toggleBulletList().run() },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-100 bg-white focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-100">
      <div className="flex shrink-0 gap-1 border-b border-neutral-100 bg-neutral-50 px-2 py-1">
        {toolbarButtons.map(({ label, icon, onClick }) => (
          <button
            key={label}
            type="button"
            title={label}
            className="rounded px-1.5 py-1 text-neutral-600 hover:bg-neutral-200"
            onClick={onClick}
          >
            {icon}
          </button>
        ))}
      </div>
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto" />
    </div>
  );
}
