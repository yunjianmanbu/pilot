import {
  Fragment,
  isValidElement,
  memo,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { copyText } from '../clipboard'
import { highlightCode } from '../highlight'
import { CheckIcon, CopyIcon } from '../icons'
import { t } from '../i18n'

type AnchorProps = ComponentPropsWithoutRef<'a'> & ExtraProps

/** 取出 `<code>` 元素的纯文本；元素缺失时返回空串。 */
function textOf(node: ReactNode): string {
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)

  // react-markdown 把围栏块渲染成 <pre><code class="language-xxx">，语言只写在
  // 内层元素的 class 上，所以这里把它读出来再自己着色。
  const element = Array.isArray(children) ? children[0] : children
  const className = isValidElement<{ className?: string }>(element)
    ? (element.props.className ?? '')
    : ''
  const lang = /language-([\w+#-]+)/.exec(className)?.[1]
  const code = useMemo(() => textOf(element), [element])
  const tokens = useMemo(() => highlightCode(code, lang), [code, lang])

  const copy = () => {
    const text = ref.current?.innerText ?? ''
    if (!text) return
    void copyText(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  // 认出语言才换成自己渲染的 <code>，否则保持默认输出，避免无谓的节点变化。
  const body = tokens ? (
    <code>
      {tokens.map((token, index) =>
        token.kind ? (
          <span className={`tok-${token.kind}`} key={index}>
            {token.text}
          </span>
        ) : (
          <Fragment key={index}>{token.text}</Fragment>
        ),
      )}
    </code>
  ) : (
    children
  )

  return (
    <div className="code-wrap">
      <button className="code-copy" type="button" onClick={copy} title={t('复制代码')}>
        {copied ? <CheckIcon width={14} height={14} /> : <CopyIcon width={14} height={14} />}
      </button>
      <pre ref={ref}>{body}</pre>
    </div>
  )
}

const Link = ({ node, href, children, ...props }: AnchorProps) => {
  void node
  const open = (event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (!href || !/^(https?|mailto|pilot-media):/i.test(href)) return
    event.preventDefault()
    // Modifier-click keeps the old "open in the system browser" escape hatch.
    const external = event.altKey || event.metaKey || event.ctrlKey || event.shiftKey
    void window.pilot.openLink(href, external)
  }
  return (
    <a {...props} href={href} title={href} rel="noreferrer" onClick={open}>
      {children}
    </a>
  )
}

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: Link,
          table: ({ node, ...props }) => {
            void node
            return (
              <div className="table-wrap">
                <table {...props} />
              </div>
            )
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
})
