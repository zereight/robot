import { createResource, Show } from "solid-js"

export const App = () => {
  const [info] = createResource(async () => {
    const result = await window.robot.invoke("app.info", undefined)
    return result.ok ? result.value : undefined
  })
  return (
    <main data-testid="app-root">
      <Show when={info()}>{(i) => <span data-testid="app-version">{i().version}</span>}</Show>
    </main>
  )
}
