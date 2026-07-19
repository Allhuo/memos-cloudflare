// v2 服务注册入口。每个服务文件通过 rpc() 向路由注册表注册自己的方法，
// 在此处 import 以完成注册。实现进度见 ROADMAP.md 与 tracking issue。
// 尚未注册的方法由 router 统一返回 Connect "unimplemented" 错误。
