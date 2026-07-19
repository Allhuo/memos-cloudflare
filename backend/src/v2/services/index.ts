// v2 服务注册入口。每个服务文件通过 rpc() 向路由注册表注册自己的方法，
// 在此处 import 以完成注册。未注册的方法由 router 统一返回 Connect "unimplemented"。
import "./auth";
import "./instance";
import "./user";
import "./memo";
import "./attachment";
import "./shortcut";
import "./idp";
import "./ai";
