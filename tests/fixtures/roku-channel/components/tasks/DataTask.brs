sub init()
    m.top.functionName = "fetchData"
end sub

function fetchData() as object
    response = makeGraphqlCall(m.top.requestUrl, "{}", {})
    return response
end function
