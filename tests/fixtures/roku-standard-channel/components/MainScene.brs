sub init()
    m.homeView = m.top.findNode("homeView")
    m.detailView = m.top.findNode("detailView")
    m.homeView.setFocus(true)
end sub

sub onItemSelected()
    m.homeView.visible = false
    m.detailView.visible = true
    m.detailView.setFocus(true)
end sub
