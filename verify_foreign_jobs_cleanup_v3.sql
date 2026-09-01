-- ROOK — verify the v3 foreign-jobs cleanup worked (includes the
-- "XX - City" country-code pattern)

select count(*) as remaining_foreign_active_jobs
from jobs
where status = 'active'
  and (
    job_lng > 0
    or location_raw ~ '^[A-Z]{2}\s*-'
       and substring(location_raw from '^([A-Z]{2})') not in (
         'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
         'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
         'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
         'VA','WA','WV','WI','WY','DC','PR'
       )
    or exists (
      select 1
      from unnest(array[
        'china','india','germany','united kingdom','canada','mexico',
        'brazil','france','japan','australia','singapore','spain','italy',
        'netherlands','switzerland','ireland','poland','sweden','belgium',
        'south korea','taiwan','hong kong','philippines','vietnam',
        'thailand','malaysia','indonesia','south africa','israel','turkey',
        'argentina','colombia','chile','portugal','austria','denmark',
        'norway','finland','czech republic','romania','hungary','greece',
        'new zealand','united arab emirates','saudi arabia','egypt','russia',
        'mumbai','bangalore','bengaluru','delhi','new delhi','hyderabad',
        'pune','chennai','gurgaon','gurugram','noida','kolkata',
        'shanghai','beijing','shenzhen','guangzhou','manila','jakarta',
        'kuala lumpur','bangkok','ho chi minh city','hanoi','seoul',
        'tokyo','osaka','sao paulo','mexico city','dubai','tel aviv'
      ]) as term
      where location_raw ~* ('\y' || term || '\y')
    )
  );
