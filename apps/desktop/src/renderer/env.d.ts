import type { RobotBridge } from "@robot/shared"

declare global {
  interface Window {
    readonly robot: RobotBridge
  }
}
