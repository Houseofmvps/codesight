sub init()
    m.homeView = m.top.findNode("homeView")
    m.loginView = m.top.findNode("loginView")
    m.errorModal = m.top.findNode("errorModal")
    m.top.observeField("someField", "handleSome")
    m.global.AddField("token", "string", false)
    ShowScreen(m.homeView)
end sub

sub showLogin()
    ShowScreen(m.loginView, true)
end sub

sub showError()
    ShowScreen(m.errorModal, true)
end sub
